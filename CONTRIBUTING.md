# Contributing
## Pull Requests
- Name pull requests using the imperative mood (i.e. "Add feature", or "Fix bug").
- Each pull request should focus on a single, clear change.
- All pull requests are squashed and merged, so ensure your pull request accurately summarizes the change.

## Code Style
This project uses [ESLint](https://eslint.org/) and [Prettier](https://prettier.io/) for linting and formatting.

You can lint and format your code by running:
```shell
make lint-fix
```

## Development
### First-time Setup
1. Clone with submodules (the `gnome-shell` typing reference lives under `submodules/`):
   ```shell
   git clone --recurse-submodules https://github.com/boerdereinar/copyous
   ```
   If you already cloned without submodules: `git submodule update --init --depth=1`.
2. Install [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/installation).
3. Install build tooling — most distros ship these with `gnome-shell` already: `make`, `jq`, `xgettext`, `glib-compile-resources`, `glib-compile-schemas`. SQLite (`sqlite3`) is optional; without it the test database is skipped.
4. First `pnpm install` runs the project's `install` lifecycle script (`make install`) and prompts to approve native build scripts for `esbuild` and `@parcel/watcher`. These are approved in `pnpm-workspace.yaml`.

### Configuration
Copy `.env.template` to `.env` and customise as needed. Values are loaded by the Makefile.
```shell
cp .env.template .env
```

Key variables:
- `DBPATH` — path to the SQLite database used by the nested shell. Defaults to a generated test DB with 40 entries (`dist/database/test.db`). **Set this to empty** (`DBPATH =`) to point the nested shell at your real personal clipboard data.
- `DEBUG_SCHEMA` — path to a dconf-format settings file loaded into `/org/gnome/shell/extensions/copyous/debug/` before launch. Useful for overriding settings (e.g. a non-conflicting shortcut) just for the nested session.
- `GDA_VERSION` — pin `5.0` or `6.0` when both libgda majors are installed.
- `ACTIONS` — path to a custom actions config; `default` uses the built-in.
- `RESOLUTION` / `TEXT_DIRECTION` — nested-shell window sizing and RTL toggle (only effective on GNOME Shell ≤ 48; GNOME 49+ uses `mutter-devkit` and ignores these).

### Debugging
> [!IMPORTANT]
> GNOME Shell 49 and above requires `mutter-devkit` to be installed to run a nested GNOME Shell instance.
> <details>
> <summary>Install Mutter Devkit</summary>
>
> | Distro        | Command                            | Binary location           |
> |---------------|------------------------------------|---------------------------|
> | Fedora        | `sudo dnf install mutter-devel`    | `/usr/libexec/mutter-devkit` |
> | Arch Linux    | `sudo pacman -S mutter-devkit`     | `/usr/lib/mutter-devkit`  |
> | Ubuntu/Debian | `sudo apt install mutter-dev-bin`  | `/usr/libexec/mutter-devkit` |
> | openSUSE      | `sudo zypper install mutter-devel` | `/usr/libexec/mutter-devkit` |
>
> The Makefile autodetects both `/usr/libexec/mutter-devkit` and `/usr/lib/mutter-devkit`. If your distro puts it elsewhere, pass `MUTTER_DEVKIT=/path/to/mutter-devkit` to `make`.
> </details>

#### Extension
Install the extension and run a nested GNOME Shell instance for development and testing.
```shell
make launch
```

#### Settings
Install the extension and launch extension settings while also observing gjs/gnome-shell logs and dconf changes.
```shell
make launch-settings
```

#### Testing in the nested shell
Two pitfalls when iterating on shortcut/dialog behaviour:

- **JS module cache:** `gnome-extensions disable && gnome-extensions enable` does **not** reload the extension's JavaScript on Wayland — GJS keeps the module cached. To pick up source changes on the host shell, log out and back in. To avoid touching the host session, use `make launch` (nested shell, fresh GJS context).
- **Global shortcuts:** keyboard shortcuts like `Shift+Super+V` are claimed by the host GNOME session and never reach the nested shell. Either change the shortcut in the nested session via a debug schema (`DEBUG_SCHEMA=...` in `.env`), or trigger the dialog via DBus from a script. Example:

  ```shell
  # Find the nested shell's DBus session bus
  NESTED_PID=$(pgrep -f '^gnome-shell --devkit')
  export DBUS_SESSION_BUS_ADDRESS=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)

  # Open the clipboard dialog inside the nested session
  gdbus call --session \
      --dest org.gnome.Shell.Extensions.Copyous \
      --object-path /org/gnome/Shell/Extensions/Copyous \
      --method org.gnome.Shell.Extensions.Copyous.Show
  ```

#### Reading logs
Logs from `make launch` go to its stdout/stderr — redirect to a file if you want to grep them later:
```shell
make launch > /tmp/copyous-launch.log 2>&1 &
grep '\[Copyous\]\|\[perf\]' /tmp/copyous-launch.log
```

Logs from the host shell live in the journal:
```shell
journalctl --user --since "2 minutes ago" /usr/bin/gnome-shell | grep '\[Copyous\]'
```

### Profiling
Performance instrumentation is built in to help diagnose slow first-open and similar issues.

**Phase 1 (current):** timing logs guarded by `/* DEBUG-ONLY */` comments in source. Always on in dev builds, auto-stripped from release builds by the Makefile rule that strips DEBUG-ONLY blocks (`make` target with `RELEASE=1`).

Spans currently emitted:
- `[perf] initEntryTracker: N entries, load=Xms build=Yms` — time to load entries from the database (`load`) vs. time to construct `ClipboardItem` actors (`build`), measured at extension enable.
- `[perf] dialog.open: sync=Xms toIdle=Yms` — synchronous time inside `open()` (`sync`) vs. time from `open()` entry until the next idle dispatch (`toIdle`), a proxy for first-paint completion.

To capture them: build a dev build (`make install` — not `RELEASE=1`), reload the extension (log out/in, or `make launch`), trigger the path, then read logs as above.

**Planned phases:**
- Phase 2 — runtime toggle via gsettings (`enable-perf-logging`) so users can flip profiling on/off without rebuilding.
- Phase 3 — benchmark mode (`COPYOUS_PERF=1`) that generates synthetic entries of configurable size/type mix and drives `open()` programmatically over DBus for reproducible numbers. Pair with a `scripts/bench.sh` that prints before/after deltas.
- Phase 4 — optional GJS native profiler integration via `gnome-shell --profile=$out.syscap` for flame graphs.

### Useful Resources
- https://gjs.guide/extensions/
- https://gjs-docs.gnome.org/
- https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/js
