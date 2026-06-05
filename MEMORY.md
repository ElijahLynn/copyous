# MEMORY

Durable context for the `perf-fork` branch. Things future contributors (or future-you) need to know that aren't obvious from the code, git log, or CONTRIBUTING.md.

## Why this fork exists

Slow first-open of the clipboard dialog with large clipboard histories (5-10 seconds on host shell with ~400 entries, mostly disappearing on a fresh shell). Upstream issues describe the symptom: [#128](https://github.com/boerdereinar/copyous/issues/128), [#72](https://github.com/boerdereinar/copyous/issues/72), [#139](https://github.com/boerdereinar/copyous/issues/139). Upstream PRs #130 (cached Intl instances, search hot paths) and #133 (grab race) help but don't fix the dominant cost. Fork attacks the dominant cost directly.

## Architecture decisions

### Lazy realize (shipped, working)
- During bulk load (extension enable), `ClipboardScrollContainer` inserts only the first 30 items as children. The rest are pushed to `_deferred` and added later in `GLib.idle_add` batches of 20 after `dialog.open()` returns.
- Gated by `beginBulkLoad()` / `endBulkLoad()` in `extension.ts:initEntryTracker`, so runtime clipboard inserts (single new items) always go straight into the container.
- Entries are returned newest-first by `MemoryDatabase.entries()` (sorted by datetime desc), so deferring items 31+ keeps the most recent 30 visible immediately.
- Caveat: deferred items aren't searchable until they drain. Drain takes ~300ms in nested, ~4-5s on host with 400 entries. Acceptable trade-off — users typically interact with the top items.

### Pre-mapped dialog (reverted — broke click interaction)
Attempted and reverted. The idea: keep the dialog widget mapped (`visible: true`) at construction so `open()` doesn't pay the Clutter realize/map cascade each time. This worked for performance (`show=0ms`) but broke click interaction:

1. **First attempt** (`reactive: false` toggle): Clutter hit-testing ignores opacity — invisible children (settings button, search entry, etc.) still captured clicks through the full-screen overlay. Clicks on the top panel area opened Copyous settings unprompted.

2. **Second attempt** (`vfunc_pick` override): overrode `vfunc_pick(pickContext)` to short-circuit when closed, calling `super.vfunc_pick(pickContext)` only when open. Clicks outside the dialog passed through correctly when closed. But **clicks inside the dialog were broken when open** — entries couldn't be clicked, search field was slow. `super.vfunc_pick()` in GJS apparently doesn't dispatch to St.Widget descendants the way the C-level pick normally does. Root cause not fully diagnosed.

3. **Also caused**: `vfunc_map` fires during `super()` constructor when `visible: true` — before `_scrollView`/`_header` are assigned. Caused `TypeError: can't access property "navigate_focus", this._scrollView is undefined` on every extension enable. Recoverable but noisy.

**Conclusion**: skip-show optimization needs a different approach to hit-test gating. Ideas not yet tried: manually iterating children in `vfunc_pick`, `Clutter.PickMode`, moving the actor offscreen via `translation_y` (constraints don't affect translations), or hiding only `_dialog` (not the outer widget) on close. The warm-path `show=112ms` cost is the remaining budget gap.

## Current state (as of revert commit e1b8cbc)

**What's shipped and working:**
- Lazy realize ✅ (cold 1300ms → ~115ms)
- Debug schema data-destruction bug fix ✅
- Makefile mutter-devkit Arch path fix ✅
- Finer-grained `dialog.open` instrumentation ✅ (`grab=`, `emit=`, `show=`, `tail=` breakdown)
- CONTRIBUTING.md with profiling docs + perf budget ✅

**What's reverted:**
- Pre-mapped dialog optimization (broke clicks, see above)

**Keyboard shortcut:** `Ctrl+Alt+C` (changed from default `Shift+Super+V` to match macOS paste-app muscle memory). Had to remove a stale GNOME custom keybinding (`dconf custom-keybindings/custom0`) that previously launched CopyQ with the same combo. CopyQ itself was already uninstalled; only the keybinding + config remnants lingered.

## Critical gotchas

### GJS module cache (Wayland)
`gnome-extensions disable && enable` does **not** reload the extension's JavaScript on Wayland — GJS caches the module. To pick up source changes on the host shell, you must log out and log back in. For iteration, use `make launch` (nested shell, fresh GJS context). This burned a lot of cycles in early debugging — instrumentation builds were on disk but the running shell still ran older code.

### The `.debug` schema can prune your real data
Running `make launch` with `DBPATH=` empty (real personal clipboard data) used to silently shrink `~/.local/share/copyous@boerdereinar.dev/clipboard.json` from 400+ entries down to 50, because the `.debug` schema namespace has independent defaults (`history-length=50`) and the extension's `entryTracker.init()` calls `deleteOldest()` against those defaults. Fixed in commit `6aa0e4e` (Makefile + extension treat `DEBUG_SCHEMA=default` as "no debug schema"), but still possible to trigger if you point `DEBUG_SCHEMA` at a custom dconf file that doesn't pin `history-length`. Always back up `clipboard.json` before pointing the nested shell at real data.

### Host shell ages
Same Copyous code runs 1-2× slower on a 2-day-old gnome-shell than a fresh one. Memory pressure, fragmented JS heap, accumulated extension state — none of which we can fix from Copyous's side. But it's the reason "feels fast after login" became "feels slow again after a few days" before the perf fixes. Lazy realize makes Copyous more resilient to host-state degradation by reducing the absolute work the host environment has to amplify.

### Keybinding conflicts
GNOME custom keybindings (in `dconf /org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/`) silently steal combos from extensions registered via `Main.wm.addKeybinding`. If a Copyous shortcut doesn't fire, check there first. After removing a conflicting binding, the extension needs a disable+enable cycle to re-register successfully.

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
| `perf-fork` (lazy-realize only), host fresh | 115ms | 164ms | ~115ms | ~164ms |
| `perf-fork` (lazy + pre-mapped), nested | 11ms | 30ms | 16-25ms | 16-30ms |
| `perf-fork` (lazy + pre-mapped), host fresh | 31ms sync, show=0ms | 2110ms (drain interference) | — | — |

Budget (from CONTRIBUTING.md): warm toIdle median <100ms, p95 <150ms, cold <200ms.

## Open work

- **Warm-path optimization**: `show=112ms` is the remaining budget gap. Pre-mapped dialog is the right idea but needs a working hit-test gating mechanism (see reverted section above). This is the single highest-leverage remaining item.
- **Phase 2-4 profiling buildout**: runtime gsettings toggle, `COPYOUS_PERF=1` synthetic benchmark, GJS native profiler integration.
- **Upstream report**: the JSON load race in `entryTracker.initJson` falls back to in-memory and fires "Failed to load JSON" toast on transient I/O hiccups (e.g. during rapid extension disable/enable). `extension.disable()` doesn't await the destroy chain.
- **CopyQ cleanup**: package was already uninstalled but stale GNOME keybinding + config dirs + global-shortcuts registration lingered. Cleaned up manually; not automated.
