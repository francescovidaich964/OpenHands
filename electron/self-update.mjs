/**
 * "Custom build" self-update for the desktop app (fork-only feature).
 *
 * Builds a new installer from the local clone this app was built from
 * (`npm run build:desktop`), archives it, and installs it through a detached
 * PowerShell helper after the app quits. The renderer drives it through the
 * `agentCanvasSelfUpdate` bridge in preload-main.cjs. Everything here is
 * self-contained so upstream files only need a one-line registration.
 *
 * Security: handlers answer only the app's own main window (main frame, loopback
 * origin) and never accept commands, scripts or arbitrary paths from the
 * renderer — `install` takes a path that must be an installer inside the
 * archive directory.
 */

import { spawn, execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import {
  HELPER_LAUNCHER_PS1,
  INSTALL_HELPER_PS1,
} from "./lib/install-helper-script.mjs";
import {
  ARCHIVE_KEEP,
  BUILD_LOG_MAX_LINES,
  archiveFileName,
  findNewestInstaller,
  isArchivedInstallerPath,
  isTrustedSender,
  lastInstallRun,
  parseArchiveFileName,
  parseLogLines,
  resolveRepoPath,
  selectArchiveToPrune,
  sortArchive,
  splitChunk,
  trimLog,
} from "./lib/self-update-logic.mjs";
import { isLoopbackAppUrl } from "./lib/window-url-policy.mjs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const CHANNEL = {
  status: "self-update:status",
  build: "self-update:build",
  cancel: "self-update:cancel",
  install: "self-update:install",
  listArchive: "self-update:list-archive",
  log: "self-update:log",
};

const LOG_FLUSH_MS = 100;
const OVERRIDE_FILE = "self-update.json";

export function getArchiveDir() {
  const base =
    process.env.LOCALAPPDATA ??
    join(process.env.USERPROFILE ?? tmpdir(), "AppData", "Local");
  return join(base, "AgentCanvasBuilds");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function run(cmd, args, cwd, env) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      env,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      error: err?.stderr?.trim?.() || err?.message || String(err),
    };
  }
}

async function onPath(cmd) {
  const r = await run(process.platform === "win32" ? "where.exe" : "which", [
    cmd,
  ]);
  return r.ok;
}

function listDir(dir) {
  try {
    return readdirSync(dir).flatMap((name) => {
      try {
        const st = statSync(join(dir, name));
        return st.isFile()
          ? [{ name, mtimeMs: st.mtimeMs, size: st.size }]
          : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * @param {object} deps
 * @param {import("electron").App} deps.app
 * @param {import("electron").IpcMain} deps.ipcMain
 * @param {() => import("electron").BrowserWindow | null} deps.getMainWindow
 */
export function registerSelfUpdate({ app, ipcMain, getMainWindow }) {
  const archiveDir = getArchiveDir();
  const supported = process.platform === "win32";

  /** @type {{running: boolean, child: import("node:child_process").ChildProcess | null, startedMs: number, lines: string[], cancelled: boolean, result: object | null}} */
  const build = {
    running: false,
    child: null,
    startedMs: 0,
    lines: [],
    cancelled: false,
    result: null,
  };

  const trusted = (event) => {
    const win = getMainWindow();
    return isTrustedSender({
      senderIsMainWindow: Boolean(
        win && !win.isDestroyed() && event.sender === win.webContents,
      ),
      senderIsMainFrame: event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url,
      isLoopbackAppUrl,
    });
  };

  /** Wrap a handler: reject untrusted senders, never throw to the renderer. */
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) return { ok: false, error: "untrusted sender" };
      try {
        return await fn(...args);
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });
  };

  const buildInfo = () => readJson(join(__dirname, "build-info.json"));
  const repoPath = () =>
    resolveRepoPath(
      buildInfo(),
      readJson(join(app.getPath("userData"), OVERRIDE_FILE)),
    );

  // ── status ──────────────────────────────────────────────────────────────────
  handle(CHANNEL.status, async () => {
    const info = buildInfo();
    const out = {
      ok: true,
      supported,
      packaged: app.isPackaged,
      repoPath: repoPath(),
      installedSha: info?.commitSha ?? null,
      installedBranch: info?.branch ?? null,
      buildTime: info?.buildTime ?? null,
      gitFound: await onPath("git"),
      npmFound: await onPath("npm"),
      branch: null,
      headSha: null,
      clean: null,
      pendingCommits: [],
      // Display-only problems (listing pending commits) must not block Build.
      pendingCommitsError: null,
      lastInstall: lastInstallRun(readText(join(archiveDir, "install.log"))),
      error: null,
      build: {
        running: build.running,
        log: build.lines.slice(-BUILD_LOG_MAX_LINES),
        result: build.result,
      },
    };
    if (!out.repoPath) {
      out.error =
        "No clone path: this app was not built with build-info (run npm run build:desktop).";
      return out;
    }
    if (!existsSync(out.repoPath)) {
      out.error = `Clone not found at ${out.repoPath}`;
      return out;
    }
    if (!out.gitFound) {
      out.error = "git was not found on PATH";
      return out;
    }
    const [branch, head, porcelain] = await Promise.all([
      run("git", ["rev-parse", "--abbrev-ref", "HEAD"], out.repoPath),
      run("git", ["rev-parse", "HEAD"], out.repoPath),
      run("git", ["status", "--porcelain"], out.repoPath),
    ]);
    if (!head.ok) {
      out.error = head.error;
      return out;
    }
    out.branch = branch.ok ? branch.stdout.trim() : null;
    out.headSha = head.stdout.trim();
    out.clean = porcelain.ok ? porcelain.stdout.trim() === "" : null;
    if (out.installedSha && out.installedSha !== out.headSha) {
      const log = await run(
        "git",
        ["log", `${out.installedSha}..HEAD`, "--oneline", "-n", "20"],
        out.repoPath,
      );
      if (log.ok) out.pendingCommits = parseLogLines(log.stdout);
      else out.pendingCommitsError = log.error;
    }
    return out;
  });

  // ── build ───────────────────────────────────────────────────────────────────
  let pendingLog = [];
  let logTimer = null;
  const flushLog = () => {
    clearTimeout(logTimer);
    logTimer = null;
    if (!pendingLog.length) return;
    const batch = pendingLog;
    pendingLog = [];
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(CHANNEL.log, batch);
  };
  const pushLines = (lines) => {
    if (!lines.length) return;
    build.lines.push(...lines);
    trimLog(build.lines, BUILD_LOG_MAX_LINES);
    pendingLog.push(...lines);
    if (!logTimer) logTimer = setTimeout(flushLog, LOG_FLUSH_MS);
  };

  const finishBuild = async (code, repo, startedMs) => {
    build.running = false;
    build.child = null;
    flushLog();
    if (build.cancelled) {
      build.result = { ok: false, cancelled: true, error: "Build cancelled" };
      return build.result;
    }
    if (code !== 0) {
      build.result = { ok: false, error: `Build exited with code ${code}` };
      return build.result;
    }
    try {
      const outDir = join(repo, "dist-electron");
      const installer = findNewestInstaller(listDir(outDir), startedMs);
      if (!installer) {
        build.result = {
          ok: false,
          error: `No installer written after the build started in ${outDir}`,
        };
        return build.result;
      }
      const pkg = readJson(join(repo, "package.json"));
      const version = pkg?.version ?? "unknown";
      const sha =
        (
          await run("git", ["rev-parse", "--short", "HEAD"], repo)
        ).stdout.trim() || "nosha";
      mkdirSync(archiveDir, { recursive: true });
      const dest = join(archiveDir, archiveFileName(version, sha));
      copyFileSync(join(outDir, installer.name), dest);
      for (const name of selectArchiveToPrune(
        listDir(archiveDir),
        ARCHIVE_KEEP,
      )) {
        try {
          unlinkSync(join(archiveDir, name));
        } catch {
          // best-effort: an installer that is in use stays until the next build
        }
      }
      build.result = { ok: true, installerPath: dest, version, sha };
    } catch (err) {
      // e.g. the copy into the archive failed (disk full, file locked)
      build.result = {
        ok: false,
        error: `Archiving the installer failed: ${err?.message ?? err}`,
      };
    }
    return build.result;
  };

  handle(CHANNEL.build, async () => {
    if (!supported) return { ok: false, error: "Only supported on Windows" };
    if (build.running)
      return { ok: false, error: "A build is already running" };
    const repo = repoPath();
    if (!repo || !existsSync(repo))
      return { ok: false, error: "Clone path unavailable" };
    const porcelain = await run("git", ["status", "--porcelain"], repo);
    if (!porcelain.ok) return { ok: false, error: porcelain.error };
    if (porcelain.stdout.trim() !== "") {
      return { ok: false, error: "The working tree has uncommitted changes" };
    }

    build.running = true;
    build.cancelled = false;
    build.lines = [];
    build.result = null;
    build.startedMs = Date.now();
    const startedMs = build.startedMs;
    pushLines([`> npm run build:desktop  (${repo})`]);

    return new Promise((resolvePromise) => {
      // shell:true — on Windows npm is npm.cmd, which spawn() will not run directly.
      const child = spawn("npm run build:desktop", {
        cwd: repo,
        shell: true,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      build.child = child;
      let outRest = "";
      let errRest = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => {
        const r = splitChunk(outRest, c);
        outRest = r.rest;
        pushLines(r.lines);
      });
      child.stderr.on("data", (c) => {
        const r = splitChunk(errRest, c);
        errRest = r.rest;
        pushLines(r.lines);
      });
      child.on("error", (err) => {
        pushLines([`spawn error: ${err.message}`]);
        void finishBuild(-1, repo, startedMs).then(resolvePromise);
      });
      child.on("close", (code) => {
        pushLines([outRest, errRest].filter(Boolean));
        void finishBuild(code, repo, startedMs).then(resolvePromise);
      });
    });
  });

  // ── cancel ──────────────────────────────────────────────────────────────────
  handle(CHANNEL.cancel, async () => {
    const child = build.child;
    if (!build.running || !child?.pid)
      return { ok: false, error: "No build is running" };
    build.cancelled = true;
    // Killing only the shell would leave electron-builder & friends running.
    await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    return { ok: true };
  });

  // ── archive ─────────────────────────────────────────────────────────────────
  const archiveEntries = () =>
    sortArchive(listDir(archiveDir)).map((e) => ({
      path: join(archiveDir, e.name),
      name: e.name,
      mtimeMs: e.mtimeMs,
      size: e.size,
      ...parseArchiveFileName(e.name),
    }));

  handle(CHANNEL.listArchive, async () => ({
    ok: true,
    archive: archiveEntries(),
  }));

  // ── install ─────────────────────────────────────────────────────────────────
  handle(CHANNEL.install, async (installerPath) => {
    if (!supported) return { ok: false, error: "Only supported on Windows" };
    if (!app.isPackaged)
      return {
        ok: false,
        error: "Install is only available in the installed app",
      };
    if (build.running) return { ok: false, error: "A build is running" };
    if (
      !isArchivedInstallerPath(installerPath, archiveDir) ||
      !existsSync(installerPath)
    ) {
      return { ok: false, error: "Not an archived installer" };
    }
    const scriptPath = join(tmpdir(), `agent-canvas-install-${Date.now()}.ps1`);
    // BOM so Windows PowerShell 5.1 reads the file as UTF-8.
    writeFileSync(scriptPath, `﻿${INSTALL_HELPER_PS1}`, "utf8");
    const launched = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        HELPER_LAUNCHER_PS1,
      ],
      undefined,
      {
        ...process.env,
        AC_HELPER_SCRIPT: scriptPath,
        AC_HELPER_APP_PID: String(process.pid),
        AC_HELPER_INSTALLER: installerPath,
        AC_HELPER_APP_EXE: process.execPath,
        AC_HELPER_INSTALL_DIR: dirname(process.execPath),
        AC_HELPER_LOG_FILE: join(archiveDir, "install.log"),
      },
    );
    const helperPid = Number.parseInt(launched.stdout.trim(), 10);
    if (!launched.ok || !Number.isInteger(helperPid) || helperPid <= 0) {
      // Stay open: quitting without a helper would leave the user with no app.
      try {
        unlinkSync(scriptPath);
      } catch {
        // best-effort
      }
      return {
        ok: false,
        error: `Could not start the install helper: ${launched.error || launched.stdout.trim() || "no PID"}`,
      };
    }
    // before-quit stops the backend stack (see main.mjs) before the process exits.
    setTimeout(() => app.quit(), 200);
    return { ok: true, helperPid };
  });
}
