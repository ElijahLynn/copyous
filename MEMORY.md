# MEMORY

Durable context for the `perf-fork` branch. Things future contributors (or future-you) need to know that aren't obvious from the code, git log, or CONTRIBUTING.md.

## Why this fork exists

Slow first-open of the clipboard dialog with large clipboard histories (5-10 seconds on host shell with ~400 entries, mostly disappearing on a fresh shell). Upstream issues describe the symptom: [#128](https://github.com/boerdereinar/copyous/issues/128), [#72](https://github.com/boerdereinar/copyous/issues/72), [#139](https://github.com/boerdereinar/copyous/issues/139). Upstream PRs #130 (cached Intl instances, search hot paths) and #133 (grab race) help but don't fix the dominant cost. Fork attacks the dominant cost directly.

## Architecture decisions

### Lazy realize (`perf:` commit)
- During bulk load (extension enable), `ClipboardScrollContainer` inserts only the first 30 items as children. The rest are pushed to `_deferred` and added later in `GLib.idle_add` batches of 20 after `dialog.open()` returns.
- Gated by `beginBulkLoad()` / `endBulkLoad()` in `extension.ts:initEntryTracker`, so runtime clipboard inserts (single new items) always go straight into the container.
- Entries are returned newest-first by `MemoryDatabase.entries()` (sorted by datetime desc), so deferring items 31+ keeps the most recent 30 visible immediately.
- Caveat: deferred items aren't searchable until they drain. Drain takes ~300ms in nested, ~5s on host with 400 entries. Acceptable trade-off — users typically interact with the top items.

### Pre-mapped dialog (`perf:` commit)
- `ClipboardDialog` constructor sets `visible=true` + `reactive=false` + `_dialog.opacity=0` so the actor tree is mapped once at extension enable. `open()` flips reactive + animates opacity; never calls `this.show()`. `close()` reverses without `this.hide()`.
- Eliminates the per-open map cascade that dominated warm `dialog.open`'s `show=` span on busy hosts (150-300ms).
- Trade-off: extension enable adds ~500ms (the cascade moved here). One-time login cost in exchange for every dialog open being instant.

### Why both fixes together?
Lazy realize alone reduces cold from ~1300ms → ~320ms on host but leaves warm at ~200ms (the dialog tree map cascade fires every open). Pre-mapped dialog alone helps warm but leaves cold-after-bulk-build expensive (~600ms). Together they hit the perf budget (see `CONTRIBUTING.md` → Performance budget).

## Critical gotchas

### GJS module cache (Wayland)
`gnome-extensions disable && enable` does **not** reload the extension's JavaScript on Wayland — GJS caches the module. To pick up source changes on the host shell, you must log out and log back in. For iteration, use `make launch` (nested shell, fresh GJS context). This burned a lot of cycles in early debugging — instrumentation builds were on disk but the running shell still ran older code.

### The `.debug` schema can prune your real data
Running `make launch` with `DBPATH=` empty (real personal clipboard data) used to silently shrink `~/.local/share/copyous@boerdereinar.dev/clipboard.json` from 400+ entries down to 50, because the `.debug` schema namespace has independent defaults (`history-length=50`) and the extension's `entryTracker.init()` calls `deleteOldest()` against those defaults. Fixed in commit `6aa0e4e` (Makefile + extension treat `DEBUG_SCHEMA=default` as "no debug schema"), but still possible to trigger if you point `DEBUG_SCHEMA` at a custom dconf file that doesn't pin `history-length`. Always back up `clipboard.json` before pointing the nested shell at real data.

### Host shell ages
Same Copyous code runs 1-2× slower on a 2-day-old gnome-shell than a fresh one. Memory pressure, fragmented JS heap, accumulated extension state — none of which we can fix from Copyous's side. But it's the reason "feels fast after login" became "feels slow again after a few days" before the perf fixes. Both fixes make Copyous resilient to host-state degradation by reducing the absolute work the host environment has to amplify.

## Iteration workflow (the loop that works)

After every src/ edit:
```shell
make install                                              # build + install zip
make launch > /tmp/copyous-launch.log 2>&1 &              # spawn nested shell
sleep 8                                                   # wait for shell to settle
NESTED_PID=$(pgrep -f '^gnome-shell --devkit')
BUS=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)

DBUS_SESSION_BUS_ADDRESS="$BUS" gdbus call --session \
    --dest org.gnome.Shell.Extensions.Copyous \
    --object-path /org/gnome/Shell/Extensions/Copyous \
    --method org.gnome.Shell.Extensions.Copyous.Show     # trigger dialog (cold)

grep '\[perf\]' /tmp/copyous-launch.log                   # read spans
pkill -f 'gnome-shell --devkit'                           # clean up
```

Nested numbers don't reproduce host environmental amplification (host is 5-200× slower for the same op), so you can't conclude "fast on host" from "fast in nested" — but you *can* conclude "broken everywhere" if nested looks bad, and "won the architectural fight" if the relative numbers improved a lot. **Always validate in nested before asking for a host logout.**

## Reference baselines (this hardware, ~400 entries)

| Setup | Cold sync | Cold toIdle | Warm sync | Warm toIdle |
|---|---|---|---|---|
| Upstream `v2.0.1` (host) | ~5-10s perceived | — | — | — |
| Upstream `main` (PR #130 + #133), host, fresh shell | 1165ms | 1306ms | 163ms | 209ms |
| Upstream `main`, host, aged 2-day shell | 1331ms | 1510ms | 194ms | 292-1145ms |
| `perf-fork` (lazy-realize only), host fresh | 322ms | 412ms | 163-219ms | 250-1083ms |
| `perf-fork` (lazy + pre-mapped), nested | 11ms | 30ms | 16-25ms | 16-30ms |
| `perf-fork` (lazy + pre-mapped), host | TBD | TBD | TBD | TBD |

Budget (from CONTRIBUTING.md): warm toIdle median <100ms, p95 <150ms, cold <200ms.

## Open work

- Validate the lazy-realize + pre-mapped fixes on host shell (needs logout).
- Phase 2-4 profiling buildout: runtime gsettings toggle, `COPYOUS_PERF=1` synthetic benchmark, GJS native profiler integration.
- Upstream report: the JSON load race in `entryTracker.initJson` falls back to in-memory and fires "Failed to load JSON" toast on transient I/O hiccups (e.g. during rapid extension disable/enable). `extension.disable()` doesn't await the destroy chain.
