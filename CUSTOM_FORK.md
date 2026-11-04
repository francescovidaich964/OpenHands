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
| appId / productName | `dev.openhands.agent-canvas` / `OpenHands Agent Canvas` (install dir `%LOCALAPPDATA%\Programs\OpenHands Agent Canvas`, confirmed in Phase 5) |
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
- `electron/self-update.mjs`: IPC handlers `status`, `build`, `cancel`, `install`, `listArchive` + `self-update:log` event. Sender must be the main window's main frame on a loopback URL. Build runs `npm run typecheck && npm run build:desktop` (the vite build does not check types). `install` only accepts a file named `Agent-Canvas-Setup-<version>-<sha>.exe` directly inside `%LOCALAPPDATA%\AgentCanvasBuilds`, and only in the packaged app.
- `electron/lib/self-update-logic.mjs` (+ `.test.mjs`): pure, unit-tested rules: archive names, installer path validation, fresh-installer discovery, pruning (keep 5), log chunking, repo-path resolution, sender trust, last helper run from `install.log`.
- `electron/lib/install-helper-script.mjs`: the PowerShell helper (waits for app exit, then for any process under the install dir, runs `/S` with a 10 min bound, logs to `install.log`, relaunches unless the app is already running, deletes itself) and the launcher that starts it. The app runs the launcher as a short-lived child; the launcher `Start-Process`es the helper (a grandchild escapes libuv's kill-on-close job; `spawn({detached:true})` of powershell.exe was measured to run nothing), checks it is still alive after 3 s and prints its PID. The app quits only after that; otherwise it stays open and shows the error.
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
| `src/i18n/translation.json` | 25 new `SELF_UPDATE$*` keys, all 16 languages (appended at the end) |

### Deviations from the runbook

- Card placement: the existing update card lives in the settings *sidebar* and opens a modal, not on the Application page. The Custom build card is rendered at the bottom of Settings > Application (one small hook in `app-settings.tsx`) and the "replaces custom build" line is inside the official update modal.
- i18n: the completeness check requires real translations in all 16 languages, not just English, so all 16 were written.
- Installer name is `OpenHands-Agent-Canvas-Setup-<version>.exe`; archive name stays `Agent-Canvas-Setup-<version>-<shortsha>.exe` as in the runbook.
- `perMachine: false`, so there is no UAC prompt on install.
- Full `npm test` hangs/fails on Windows in `__tests__/scripts/*` (Docker, Stryker, symlink, download-node tests) independent of this feature; see the Phase 5 notes below.
- A type error does **not** fail `npm run build:desktop`: `react-router build` (vite) strips types without checking them (measured: TS2322 in `src/`, `build:app` exit 0). The in-app Build therefore runs `npm run typecheck` first.
- `spawn("powershell.exe", …, {detached: true})` runs nothing on this machine (exit 0 in ~100 ms, no output), and a non-detached child dies with the app, so the helper is started as a grandchild through `Start-Process` (see the helper bullet above).
- A silent `/S` install does **not** start the app; the helper's own relaunch is what brings it back (measured, see below).

## Phase 5: verification (2026-11-04)

Commits on top of the Phase 4 work: `26aea97ae7` (encoding), `b266de9a4b` (helper launch + review fixes), `f41ac47c69` (typecheck before in-app builds, launch hardening). Checks at `f41ac47c69`: `npx vitest run electron/lib src/components/features/settings/custom-build-card.test.tsx` 84/84, `npm run typecheck` 0, eslint on the touched `src` files 0, `npm run check-translation-completeness` OK. The full `npm test` is not run here: it hangs on Windows (`.agents/skills/verify-openhands`) and has 55 pre-existing failures in `__tests__/scripts` etc. that a clean `v1.34.0` worktree shares.

Dev app (`npm run desktop`, driven over CDP): card renders on `/settings/app`; the official update modal shows "Installing an official release replaces your custom build." (not in a plain browser, where the card is also absent); an untracked file disables Build and `build()` is refused; the log streams; a second `build()` is refused while one runs; Cancel during `react-router build` and during `download-uv` killed the whole tree (7 and 5 PIDs) and left the clone clean.

Installed app (per-user, silent `/S`):

| Test | Result |
|---|---|
| CLI build of `b266de9a4b` | 239 s; `win-unpacked\resources\app\build-info.json` present; silent install 55 s, exit 0 |
| In-app Build of `f41ac47c69` -> Restart to install | build 4 min 16 s; helper started ~1 s after the click; backend and ports 8000/18000/18001 down within ~2 s; app gone within ~6 s; installer `/S` (parent = helper) 62 s, exit 0, no window; new app started by the helper at +83 s; installed sha `f41ac47c69` |
| Rollback (Reinstall previous build -> `b266de9a4b`) | dropdown defaulted to `b266de9a4b`, installed entry tagged; exit 0; relaunched by the helper; installed sha `b266de9a4b` |
| Roll forward from `b266de9a4b` (older install code) -> `f41ac47c69` | exit 0; relaunched by the helper; installed sha `f41ac47c69` |
| Commit with a type error -> Build | fails in `tsc` (TS2322, exit 2); no installer archived, `dist-electron` untouched, installed app untouched and still running |

`/S` does not start the app (in all four installs no process was started by the installer; every new instance's parent was the helper, `install.log` says `relaunched`). Downtime per install 77-118 s until the app process is back, about 20-30 s more until the backend ports answer.

`install.log` of the first in-app install:

```
2026-11-04 10:43:07  helper started: installer=...\AgentCanvasBuilds\Agent-Canvas-Setup-1.34.0-f41ac47c69.exe appPid=43540 installDir=...\Programs\OpenHands Agent Canvas
2026-11-04 10:43:22  installer started (pid 43208)
2026-11-04 10:44:24  installer exit code: 0
2026-11-04 10:44:29  relaunched ...\Programs\OpenHands Agent Canvas\OpenHands Agent Canvas.exe
2026-11-04 10:44:29  helper done
```

### Known limitations

- The build command and the install code that run are the **installed** app's, not the clone's: a change to `self-update.mjs` takes effect one install later.
- The build inherits the app's environment. If the app is started from a shell whose PATH puts Git's GNU `tar` before `C:\Windows\System32` (Git Bash, some agent shells), `scripts/download-uv.mjs` fails (`tar: Cannot connect to C: resolve failed`). Start-menu / Explorer launches are fine (Git's `usr\bin` is not on the user or machine PATH). A shell that exports `ELECTRON_RUN_AS_NODE=1` cannot start the app at all.
- No progress UI during the install window (the app has quit); `install.log` and the card's "Last install attempt" block are the only trace afterwards.
- If an old uninstaller fails during a silent install, electron-builder shows a MessageBox without `/SD` that nobody can see; the helper stops waiting after 10 min and then does **not** relaunch the app. Recovery: run an archived installer by hand. (Possible fix, not applied: an empty `customUnInstallCheck` macro via `nsis.include`.)
- A Cancel that lands exactly as the build finishes reports "cancelled" although the installer was archived (it still appears in the Reinstall list).
- The failure block shows the last 50 raw log lines; long vite warning lines can bury the actual error.
- A fresh profile shows the first-run onboarding screen, which hides all settings routes (upstream behaviour).
- Not tested: an install that fails (non-zero exit), a locked install dir, keep-5 pruning (only 3 archives so far), Cancel close to the end of a build.

## Upstream sync from the app (design, branch `custom/upstream-sync`)

Goal: the desktop app notices a newer upstream release, rebases the fork's `main` onto it, rebuilds and reinstalls itself, and (after the new build runs) pushes `main` to the fork. Conflicts are handed to an AI agent of the user's choice, or to the user as a copyable task.

Model of the fork: `main` = an upstream release tag (or an upstream `main` snapshot) + a straight line of fork commits (features land as squash merges). A sync is `git rebase <newest upstream tag>` on `main`; upstream commits already in the tag are skipped by git, the fork commits are replayed.

### Pieces

| Piece | What |
|---|---|
| `scripts/write-build-info.mjs` | also records `upstreamTag` = `git describe --tags --abbrev=0 --match "v[0-9]*"` (the release the build sits on) |
| `electron/upstream-sync.mjs` (new) | IPC `sync:check`, `sync:start`, `sync:agent`, `sync:abort`, `sync:discard`, `sync:push`, `sync:state`; state persisted in `<userData>/upstream-sync.json` so it survives the restart-to-install |
| `electron/lib/upstream-sync-logic.mjs` (new, + tests) | pure rules: newest release tag (`^v\d+\.\d+\.\d+$`, semver order), backup branch names, conflict-task text, agent command lines, push preconditions, phase from repo facts |
| `src/components/features/settings/upstream-sync-panel.tsx` (new, + tests) | the sync UI inside the Custom build card |
| `agent-canvas-update-card.tsx` (upstream file) | in the desktop app the sidebar card shows the upstream-release check instead of npm; its modal links to Settings > Application. Diff kept to a wrapper |

Settings (optional) in `<userData>/self-update.json` (already holds `repoPath`): `syncBranch` (default `main`), `upstreamRemote` (`upstream`), `forkRemote` (`origin`), `opencodeModel` (`ax_h200/selfhosted-model#xhigh`).

### Check

`git fetch <upstreamRemote> "+refs/tags/v*:refs/tags/v*" "+refs/heads/main:refs/remotes/<upstreamRemote>/main"` (only on an explicit Check or at most every 6 h). Not `--tags`: a clashing local tag makes git refuse the whole fetch. Not `--prune`: it would delete local tags upstream does not have. Then: `latestTag` = highest `vX.Y.Z` tag merged into `<upstreamRemote>/main` (a maintenance release cut on an unmerged branch is not offered); `updateAvailable` = `latestTag` is not an ancestor of the clone's `syncBranch`. Shown: installed build's `upstreamTag`, clone's base tag, `latestTag`, number of fork commits (`git rev-list --count <branch> --not --remotes=<upstreamRemote>`).

### Sync & install

Preconditions (refused with a message otherwise): Windows, packaged app, clone checked out on `syncBranch`, clean tree, no rebase in progress, no build running.

1. The same fetch as the Check; re-resolve `latestTag`.
2. `git branch backup/<branch>-<yyyymmdd-HHMMss>` at HEAD (recorded in the state file).
3. `git rebase <latestTag>` with `GIT_EDITOR=true`.
4. Clean: phase `rebased`, then the normal Build runs automatically (typecheck + build:desktop) and offers Restart to install.
5. Conflicts: phase `conflict`; the rebase stays in progress; the panel lists the conflicted files.

### Conflicts

The panel shows the generated task (repo, branch, target tag, backup branch, conflicted files, fork file list from this document, rules: keep the fork's behaviour, adapt it to upstream's changes, `git add` + `git rebase --continue` with `GIT_EDITOR=true` until done, then `npm run typecheck`, the self-update vitest files and `npm run check-translation-completeness`; commit fixes as new commits; never push, never reset or abort unless it cannot be resolved, then abort and explain).

- **Agent** dropdown (only CLIs found on PATH are enabled): `opencode` (`opencode run --auto -m <opencodeModel> --title agent-canvas-rebase "<prompt>"`) or `Claude Code` (`claude -p "<prompt>" --permission-mode acceptEdits --allowedTools "Bash(git *)" "Bash(npm *)" "Bash(npx *)"`), started in the clone through the same detached launcher as the install helper, output to `%LOCALAPPDATA%\AgentCanvasBuilds\sync-agent-<ts>.log` (tailed in the panel). The prompt points to the task file written next to the log (no long command lines).
- **Copy task**: the same text to the clipboard, for any agent the user runs by hand.
- **Abort sync**: `git rebase --abort` (disabled while an agent runs).
- The panel polls: when no rebase is in progress, the branch contains `latestTag` and the tree is clean, phase becomes `rebased` and Build is enabled; if the agent exits with the rebase still in progress, the panel says so and keeps Abort / Copy task available.

### After the install

Phase `installed` = the running build's `commitSha` == the branch HEAD and the branch contains `latestTag`. The panel then offers:

- **Push to fork**: `git push --force-with-lease=<branch>:<origin sha recorded before the sync> <forkRemote> <branch>`; the backup branch is kept locally.
- **Discard sync** (before pushing): `git reset --keep <backup>`; then Build + Restart to install returns to the old version (or Reinstall previous build from the archive, faster).

### Not doing

No automatic push; no sync onto upstream `main` (tags only); no interactive rebase; no sync while the clone is on another branch (feature branches are rebased by hand).

### Validation plan

Unit tests for the logic module and the panel. End to end on the installed app with a throwaway branch `test/sync-*` = `v1.34.0` + the fork commits (selected with `syncBranch`): clean sync to v1.35.0 → build → install → Push (to a throwaway remote branch only) → Discard on a second run; and a forced conflict handled once by each agent and once by Copy task.

## Upstream sync procedure (Phase 6)

1. `git fetch upstream --tags`; pick the newest release tag (`gh release list --repo OpenHands/OpenHands --limit 5`).
2. `git branch backup/self-update-$(date +%Y%m%d)`
3. `git rebase <new-tag>` on `custom/self-update`. Likely conflict spots: `electron/main.mjs`, `electron/preload-main.cjs`, `src/routes/app-settings.tsx`, `agent-canvas-update-card.tsx`, the end of `src/i18n/translation.json`, and the `build:desktop` line in `package.json`. Re-check `electron/main.mjs` still quits via `before-quit` -> SIGTERM handler (that is what stops the backend before the installer runs).
4. Run the checks: `npm run lint`, `npx vitest run electron src/components/features/settings`, `npm run check-translation-completeness`; smoke test with `npm run desktop`.
5. With approval: `git push --force-with-lease origin custom/self-update`. Then click **Build** in the installed app (it typechecks first, ~1.5 min, then builds, ~4 min), then **Restart to install** (~1.5-2 min until the app is back). Check the card's "Last install attempt" block or `install.log` for `installer exit code: 0` and `relaunched`.
6. If the rebase changed `electron/self-update.mjs` or the helper, the new code only runs from the next install; do one more Build + Restart to install if you need it active.

Locations:

- Archive of installers: `%LOCALAPPDATA%\AgentCanvasBuilds\` (newest 5 kept)
- Install log: `%LOCALAPPDATA%\AgentCanvasBuilds\install.log`
- Helper script (temporary, deletes itself when done): `%TEMP%\agent-canvas-install-<timestamp>.ps1`

Recovery if the app will not start: run the newest (or an earlier) installer in `%LOCALAPPDATA%\AgentCanvasBuilds\` by hand (double-click). It installs per-user and needs no admin rights.
