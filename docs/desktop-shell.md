# Desktop shell (optional)

`desktop/` is an optional second way to start SD Image Sorter: a small Electron
program that keeps it resident in the tray. The browser launchers (`run.bat`,
`run-portable.bat`, `run.sh`) stay, and the web UI behaves exactly the same in a
normal browser. What the shell adds:

- starts the backend for you (or uses one that already runs), shows the UI in its own window;
- closing the window keeps the program in the tray, so folder watching goes on (a one-line notice the first time; Settings > Desktop can make closing quit instead);
- one instance only: starting it again brings the window up;
- tray menu: Open, Quick collect, Pause / Resume folder watching, Quit;
- start at login (starts hidden in the tray);
- a global shortcut (default Ctrl+Alt+Space, changeable) that brings the window up with the cursor in the gallery search; if the system refuses a shortcut, Settings says so;
- native drag-out: dragging a picture card out of the classic gallery hands other programs the real file (all selected pictures when the dragged card is selected);
- Quick collect: a small always-on-top window that takes dropped, pasted or chosen pictures and adds them to the gallery. The copies are kept in `output/collected/` (the output folder from Settings), the originals are not touched. It also works in a browser (function catalog, opens as a popup).

No telemetry: the crash reporter is never started and the shell sends nothing anywhere.

## Run and build

```bash
cd desktop
npm ci
npm start          # dev: runs against this checkout
npm test           # pure helpers (node --test)
npm run dist       # unpacked Windows build in desktop/dist/win-unpacked/
npm run dist:linux # unpacked Linux build (run on Linux)
```

`desktop/node_modules/` and `desktop/dist/` are git-ignored.

### How it finds and starts the backend

1. Ports to try: `SD_IMAGE_SORTER_PORT`, else 8487, then the next 19 ports.
2. A port whose `GET /api/updates/boot-id` answers is an SD Image Sorter that already runs (from `run.bat` or another launcher): the shell **attaches** to it and never stops it.
3. Otherwise the shell starts the backend on the first free port: `python main.py --port <port>` from `backend/`, with the same package-local folders `run-portable.bat` sets (`data/`, `data/config`, models, caches, `TEMP`). Values already set in the environment win.
4. Python, in this order: `SD_IMAGE_SORTER_PYTHON` (dev override), the portable package's `python\python.exe` (`python/bin/python3` on Linux), then `backend\venv\Scripts\python.exe` (`backend/venv/bin/python`) made by `run.bat` / `run.sh`. The shell does not install packages; when Python is missing it says to run `run.bat` once.
5. The program folder is the first folder holding `backend/main.py`, looked for upward from the shell executable (so `desktop/dist/win-unpacked/` in a checkout and a future `shell/` folder in the portable package both work), or `SD_IMAGE_SORTER_APP_ROOT`.
6. No PowerShell or cmd in between: Node starts `python.exe` directly (`windowsHide`), which avoids the Huorong pattern of a hidden PowerShell making HTTP calls.
7. Exit code 75 (restart after an update or a feature install) restarts the backend on the same port and reloads the page, as the launchers' restart loop does.
8. Start-up problems show a page with the reason, the last 40 log lines (`data/logs/desktop-backend.log`), Try again and Open log folder.

### The backend never outlives the shell

The shell passes `SD_IMAGE_SORTER_PARENT_PID=<its pid>`; `backend/desktop_lifeline.py` waits on that process (Windows: `OpenProcess` + `WaitForSingleObject`, so a reused pid cannot fool it; elsewhere it checks every second) and shuts the server down gracefully when it ends. Quit therefore only exits the shell. This covers Quit, a crash, and Task Manager alike, which a Job Object would also do but needs a native module in Node.

A stdin-pipe lifeline was built first and rejected: on Windows a thread blocked reading stdin made every metadata worker process hang at start-up (scan of 4 pictures: 15.4 s and 4 timeouts with the pipe lifeline, 3.1 s and 0 errors without; bisected in the S6 spike), because the workers inherit that handle and synchronous I/O on it is serialized.

### Backend additions

- `POST /api/watch/pause {"paused": true|false}`: pause or resume all folder watching (tray menu). Each folder keeps its own switch; resuming catches up the pictures written meanwhile. A pause lasts until resumed or until the program restarts. `GET /api/watch/status` reports `paused`, and the Library folders list says "Watching paused from the tray menu".
- `POST /api/import-files?destination=collected`: Quick collect saves into `<output root>/collected` (new `collected` output feature, `name_2` on a clash) and the reply names `folder`, `saved`, `skipped` (not pictures) and the real `image_ids` (the ids were always empty before).

### Settings

- Shell settings: `data/config/desktop-shell.json` (`closeToTray`, `shortcut`, `closeNoticeShown`). Start at login is held by the OS (Windows login item; Linux `~/.config/autostart/sd-image-sorter.desktop`), started with `--hidden`.
- Classic Settings > General gets a **Desktop** section only inside the shell (`window.sdDesktop`, exposed by `desktop/src/preload.js`; contextIsolation and sandbox on). The main process answers program calls only from the program's own page on its own port.
- After 10 minutes hidden in the tray the window's page is released (memory back to the system) and reloaded on the next open.

### Updater

Not wired yet. Plan from the research: the shell is a separate, rarely changing layer with its own version (`desktop/package.json`, now 0.1.0); `app-patch.zip` keeps patching `backend/` and `frontend/`; a future manifest field `min_shell_version` tells when a new shell download is needed. Nothing in the running updater changes with this slice.

## Shell choice: spike measurements (2026-10-23)

Both spikes loaded the same isolated backend copy (port 8631, synthetic data) on the owner's PC (Windows 11, RTX 3090 machine, shared with other work, so absolute numbers carry some noise). Spike sources: the S6 scratch folder, not the repo.

| | Electron 44.7.0 (electron-builder 26.15.3) | Tauri 2 (tauri 2.12.5, CLI 2.12.3, WebView2 155) |
|---|---|---|
| Installer | 106.2 MB (NSIS) | 2.1 MB (NSIS, WebView2 already part of Windows 11) |
| Unpacked | 367.7 MB all locales; **320.4 MB** with en-US + zh-CN only (the real `desktop/` build) | 9.3 MB exe |
| Cold start to first contentful paint (shell spawn to FCP of the real classic UI) | 1705, 1178, 1103 ms; second set 1343, 1344 ms (one sample lost) | 1000, 986, 1057 ms; second set 1007, 955, 1024 ms |
| RAM, window open (all processes; working set / private working set) | 398-487 / 151-226 MB, 4 processes | 550-557 / 244-246 MB, 7 processes |
| RAM, closed to tray with the window destroyed | 250 / 71 MB, 3 processes (main, GPU, network) | 40 / 12 MB, 1 process |
| H.264 MP4 | plays (`canPlayType` probably) | plays (WebView2 on Windows) |
| VP9 WebM | plays | plays |
| Native drag-out API | `webContents.startDrag` called from the page's dragstart over IPC: returned at once | `tauri-plugin-drag` `start_drag` invoked from the page: no result and no error within 30 s when no mouse button was held |
| Tray / global shortcut / single instance | all work (Ctrl+Alt+Space registered; second launch exits and the first sees it) | all work |
| Notes | same Chromium as the Playwright suite, Windows and Linux | remote-URL pages need an app manifest + a capability with `remote.urls` before any IPC works; Linux would use WebKitGTK |

Not measurable here: a real drop into Photoshop, a browser upload field, ComfyUI's canvas and Explorer (needs a person at the mouse; listed for acceptance), and Linux (no Linux desktop on this PC).

**Decision rule** (research D, section 8): pick the smallest shell that passes drag-out into all four targets on Windows and plays H.264/VP9 on both OSes without extra packages; otherwise Electron.

**Decision: Electron.** Tauri is far smaller and lighter in the tray, but the rule's conditions cannot be shown for it: its drag-out call did not complete in the automated check while Electron's did, the four real drop targets need a manual test, and on Linux Tauri renders with WebKitGTK, whose H.264 playback depends on distro GStreamer packages (Tauri/WebKit docs) - "without extra packages" fails there. With the rule inconclusive, the brief says Electron. To narrow Electron's tray cost, the shell releases the page after 10 minutes hidden (the 71 MB private / 250 MB working-set row above is that state). The shell is kept thin (tray, shortcut, drag, windows, child process) so a later port to Tauri stays cheap if size or tray RAM draws complaints.

## Verification (S6)

- `desktop`: `npm test` - 13 pure-helper tests (app-root search, Python choice, backend env, port plan/attach, origin check, drag paths, shortcut parsing, settings, strings in both languages, Linux autostart entry).
- Backend: `tests/test_desktop_shell_backend.py` (pause/resume, pause endpoint, Quick collect folder/skip/ids, unchanged default import, refused destination, lifeline fires on shell exit and for an already-gone shell, lifeline off by default).
- Packaged shell driven with Playwright's Electron support on an isolated copy (port 8631, scratch data, synthetic pictures, windows kept off the visible screen): backend started by the shell, UI shown, second launch focuses the first, close keeps it in the tray with the backend answering, the registered Ctrl+Alt+Space callback shows the window with `#gallery-search-input` focused (a real OS key press was also checked once), dragstart on a card cancels the browser drag and calls `startDrag` with the card's file, and with both files of a two-card selection, Settings > Desktop toggles and shortcut capture, tray Pause/Resume reaching `/api/watch/status`, Quick collect importing a dropped synthetic PNG into `output/collected` and the gallery refreshing, no console errors. Process list before Quit: shell processes + `python main.py --port 8631`; after Quit: none. Killing only the shell's main process: the backend left within 8 s.

### Owner acceptance (needs a person)

1. Drag a picture card from the shell's gallery into Explorer, Photoshop, a browser upload field and ComfyUI's canvas; each should receive the real file. Drag two selected cards into Explorer.
2. Right-click the tray icon: the menu shows Open, Quick collect, Pause folder watching, Quit; Pause turns into Resume.
3. Press Ctrl+Alt+Space from another program (for example while a game or full-screen video has focus).
4. Turn on Start at login, sign out and in: the tray icon appears without a window.
5. With Huorong running, start the shell and check nothing is flagged.
