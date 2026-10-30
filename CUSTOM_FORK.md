# Custom fork notes (Agent Canvas desktop)

This is Francesco's fork of `OpenHands/OpenHands`. Branch `custom/self-update`
is based on release tag `v1.34.0` and adds a **Rebuild & Install** feature to
the desktop app. This file logs what was changed, why, and where reality
differed from the runbook.

- Clone: `C:\Projects\personal\OpenHands` (runbook suggested `C:\dev\agent-canvas`; changed at Francesco's request)
- Remotes: `origin` = fork, `upstream` = `https://github.com/OpenHands/OpenHands.git` (the fork's GitHub parent)
- Base tag: `v1.34.0` (GitHub "Latest"; `main` was 37 commits ahead)

## Phase 2: verified assumptions

| Assumption | Result |
|---|---|
| package name `@openhands/agent-canvas` | Confirmed (version 1.34.0) |
| `desktop` script | Confirmed: `npm run build:app && electron electron` (with `predesktop` = `scripts/brand-dev-electron.mjs`) |
| `build:desktop` script | Confirmed: `build:app && download-uv && download-node && electron-builder --config electron-builder.config.mjs --publish never` |
| Electron code in `electron/` | Confirmed: `main.mjs`, `preload-main.cjs` (main window), `preload.cjs` (splash window), `lib/*.mjs` (+ tests), `package.json`, `loading.html` |
| Installer output dir | `dist-electron` (git-ignored) |
| NSIS options | `oneClick: false`, `perMachine: false` (per-user, **no UAC**), `allowToChangeInstallationDirectory: true`, desktop + start menu shortcuts |
| Installer file name | `OpenHands-Agent-Canvas-Setup-${version}.exe` (**differs** from runbook's `Agent-Canvas-Setup-<version>.exe`; still matches `*Setup*.exe`) |
| appId / productName | `dev.openhands.agent-canvas` / `OpenHands Agent Canvas` (install dir expected `%LOCALAPPDATA%\Programs\OpenHands Agent Canvas`; to confirm in Phase 3) |
| Backend start / stop | `startStack()` imports `scripts/dev-with-automation.mjs` and runs it in-process (children spawned detached). On quit, `before-quit` calls `process.emit("SIGTERM")` on win32, which runs the registered shutdown hook that kills all child process trees; 6 s safety net `app.exit(0)`. `app.quit()` therefore stops the backend. |
| Preload bridges | `contextBridge.exposeInMainWorld`, `contextIsolation: true`, `nodeIntegration: false`. Main window preload exposes `desktopShell` and `marsBridge`; CommonJS only (sandboxed). |
| Update card location | **Differs**: `AgentCanvasUpdateCard` (`src/components/features/settings/agent-canvas-update-card.tsx`) renders in the settings *sidebar* (`settings-desktop-sidebar.tsx`, `settings-mobile-hub.tsx`, `settings-mobile-drawer.tsx`) and opens a modal. It is not on the Application settings page (`src/routes/app-settings.tsx`). It compares the npm registry's latest version against `AGENT_CANVAS_CLIENT_VERSION`. |
| electron-updater present | No. Only `electron` 43.3.0 and `electron-builder` 26.15.3 (dev deps). |

Other facts:

- Test / typecheck / lint: `npm test` (runs `make-i18n` then `vitest run`), `npm run typecheck`, `npm run lint` (typecheck + eslint src + prettier on src), `npm run check-translation-completeness`.
- Vitest picks up `electron/lib/*.test.mjs` (existing example: `window-url-policy.test.mjs`), so pure logic for the feature goes in `electron/lib/` with tests next to it.
- The translation check needs **all 16 languages** with genuinely translated values (not copies of English), not just English keys. Runbook said "English at minimum"; that is insufficient here.
- electron-builder `files: ["**/*", ...]` with `directories.app = electron` bundles everything in `electron/`, so a generated `electron/build-info.json` ships in the app.

## Log of changes

### Baseline (Phase 3)

- `npm ci` OK (no native-module problems; VS Build Tools 2022 present). `npm run desktop` smoke test: backend came up (`/server_info` 200), renderer connected; closing the window left no electron/uv/python processes and freed ports 8000/18000/18001.
- `npm run build:desktop`: 205 s. Installer `dist-electron\OpenHands-Agent-Canvas-Setup-1.34.0.exe`, 135.4 MB, SHA-256 `C0CA6F58A63C5668E60B665C2A596A1EF1103BFB13486400D80017B9720984C8`, archived as `%LOCALAPPDATA%\AgentCanvasBuilds\Agent-Canvas-Setup-1.34.0-6c120073f5.exe`.

### Rebuild & Install feature (Phase 4)

New files (fork-only, no upstream conflicts expected):

- `scripts/write-build-info.mjs`: writes git-ignored `electron/build-info.json` (`repoPath`, `commitSha`, `branch`, `buildTime`); hooked into `build:desktop` right after `build:app`. Optional override: `%APPDATA%\<app userData>\self-update.json` with `{"repoPath": "..."}` if the clone moves.
- `electron/self-update.mjs`: IPC handlers `status`, `build`, `cancel`, `install`, `listArchive` + `self-update:log` event. Sender must be the main window's main frame on a loopback URL. `install` only accepts a `.exe` directly inside `%LOCALAPPDATA%\AgentCanvasBuilds` and only in the packaged app.
- `electron/lib/self-update-logic.mjs` (+ `.test.mjs`): pure, unit-tested rules: archive names, installer path validation, fresh-installer discovery, pruning (keep 5), log chunking, repo-path resolution, sender trust.
- `electron/lib/install-helper-script.mjs`: the detached PowerShell helper (waits for app exit, then for any process under the install dir, runs `/S`, logs to `install.log`, relaunches unless the app is already running).
- `src/utils/self-update-bridge.ts`, `src/components/features/settings/custom-build-card.tsx` (+ test).

Upstream files touched (keep diffs tiny; these are where rebases conflict):

| File | Change |
|---|---|
| `electron/main.mjs` | +1 import, +2 lines calling `registerSelfUpdate` after the MARS bridge registration |
| `electron/preload-main.cjs` | appended `agentCanvasSelfUpdate` bridge block |
| `package.json` | `build:desktop` runs `node scripts/write-build-info.mjs` after `build:app` (`build:desktop:universal` deliberately untouched: the feature is Windows-only) |
| `.gitignore` | ignore `/electron/build-info.json` |
| `src/routes/app-settings.tsx` | wraps the form in a div and renders `<CustomBuildCard />` below it |
| `src/components/features/settings/agent-canvas-update-card.tsx` | one line in the update modal: official release replaces the custom build (only when the bridge exists) |
| `src/i18n/translation.json` | 22 new `SELF_UPDATE$*` keys, all 16 languages (appended at the end) |

### Deviations from the runbook

- Card placement: the existing update card lives in the settings *sidebar* and opens a modal, not on the Application page. The Custom build card is rendered at the bottom of Settings > Application (one small hook in `app-settings.tsx`) and the "replaces custom build" line is inside the official update modal.
- i18n: the completeness check requires real translations in all 16 languages, not just English, so all 16 were written.
- Installer name is `OpenHands-Agent-Canvas-Setup-<version>.exe`; archive name stays `Agent-Canvas-Setup-<version>-<shortsha>.exe` as in the runbook.
- `perMachine: false`, so there is no UAC prompt on install.
- Full `npm test` hangs/fails on Windows in `__tests__/scripts/*` (Docker, Stryker, symlink, download-node tests) independent of this feature; see verification notes below.

## Upstream sync procedure (Phase 6)

1. `git fetch upstream --tags`; pick the newest release tag (`gh release list --repo OpenHands/OpenHands --limit 5`).
2. `git branch backup/self-update-$(date +%Y%m%d)`
3. `git rebase <new-tag>` on `custom/self-update`. Likely conflict spots: `electron/main.mjs`, `electron/preload-main.cjs`, `src/routes/app-settings.tsx`, `agent-canvas-update-card.tsx`, the end of `src/i18n/translation.json`, and the `build:desktop` line in `package.json`. Re-check `electron/main.mjs` still quits via `before-quit` -> SIGTERM handler (that is what stops the backend before the installer runs).
4. Run the checks: `npm run lint`, `npx vitest run electron src/components/features/settings`, `npm run check-translation-completeness`; smoke test with `npm run desktop`.
5. With approval: `git push --force-with-lease origin custom/self-update`. Then click **Build** in the installed app, then **Restart to install**.

Locations:

- Archive of installers: `%LOCALAPPDATA%\AgentCanvasBuilds\` (newest 5 kept)
- Install log: `%LOCALAPPDATA%\AgentCanvasBuilds\install.log`
- Helper script (temporary): `%TEMP%\agent-canvas-install-<timestamp>.ps1`

Recovery if the app will not start: run the newest (or an earlier) installer in `%LOCALAPPDATA%\AgentCanvasBuilds\` by hand (double-click). It installs per-user and needs no admin rights.
