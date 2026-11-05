/**
 * "Custom build" self-update for the desktop app (fork-only feature).
 *
 * Builds a new installer from the local clone this app was built from
 * (`npm run make-i18n && npm run typecheck && npm run build:desktop`), archives
 * it, and installs it
 * through a PowerShell helper that outlives the app. The renderer drives it through the
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
import { repoOperation } from "./lib/repo-state.mjs";
import {
  BUILD_LOG_MAX_LINES,
  archiveFileName,
  commitRelationship,
  findNewestInstaller,
  isArchivedInstallerPath,
  isTrustedSender,
  lastInstallRun,
  needsDependencyInstall,
  parseArchiveFileName,
  parseLeftRight,
  parseLogLines,
  pullRefusal,
  resolveRepoPath,
  selectArchiveToPrune,
  sortArchive,
  splitChunk,
  trimLog,
} from "./lib/self-update-logic.mjs";
import {
  SYNC_STATE_FILE,
  resolveSyncSettings,
} from "./lib/upstream-sync-logic.mjs";
import { isLoopbackAppUrl } from "./lib/window-url-policy.mjs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const CHANNEL = {
  status: "self-update:status",
  build: "self-update:build",
  cancel: "self-update:cancel",
  install: "self-update:install",
  listArchive: "self-update:list-archive",
  fetch: "self-update:fetch",
  pull: "self-update:pull",
  log: "self-update:log",
};

const LOG_FLUSH_MS = 100;
/**
 * The card polls `status` every 30 s; that is local git only. The remote is
 * contacted by the Check button or once per this window, never concurrently.
 */
export const FETCH_MAX_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const PULL_TIMEOUT_MS = 5 * 60 * 1000;
/** Commit lines listed per direction on the card; the count is never capped. */
export const MAX_COMMIT_LINES = 20;
export const OVERRIDE_FILE = "self-update.json";
/** Next to the installers: `{ "<installer name>": { branch, builtMs } }`. */
const ARCHIVE_INDEX_FILE = "archive-index.json";
// The vite build strips types without checking them, so a commit with a type
// error would otherwise build and install fine. make-i18n first: it regenerates
// src/i18n/declaration.ts from translation.json, which typecheck and build both
// need when a rebase brought new keys in. A function, not a constant: the sync
// module reads it for the task file, and a constant here would mean a second
// copy of the command that silently goes stale.
export function buildCommand({ installDependencies = false } = {}) {
  const build =
    "npm run make-i18n && npm run typecheck && npm run build:desktop";
  // A rebase or pull that changed package-lock.json would otherwise build
  // the new code against the old node_modules.
  return installDependencies
    ? `npm ci --no-audit --no-fund && ${build}`
    : build;
}

/** mtime of a file, or null when it does not exist. */
function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
const HELPER_LAUNCH_TIMEOUT_MS = 30_000;

export function getArchiveDir() {
  const base =
    process.env.LOCALAPPDATA ??
    join(process.env.USERPROFILE ?? tmpdir(), "AppData", "Local");
  return join(base, "AgentCanvasBuilds");
}

/** Parsed JSON file, null when it is missing or unreadable. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** File text without a UTF-8 BOM, "" when it is missing. */
export function readText(path) {
  try {
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

/**
 * Run a program with an argument array (never a shell string) and swallow the
 * error into the result. Shared with the upstream sync (../upstream-sync.mjs).
 */
export async function run(cmd, args, cwd, env, timeout = 0) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      env,
      timeout,
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

/**
 * A non-interactive environment for every git call: nothing may open an editor
 * or ask for credentials in a background process. Shared with the upstream sync.
 */
export function gitEnv() {
  return {
    ...process.env,
    GIT_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Whether `cmd` resolves on PATH. */
export async function onPath(cmd) {
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
  const readArchiveIndex = () => {
    const index = readJson(join(archiveDir, ARCHIVE_INDEX_FILE));
    return index && typeof index === "object" && !Array.isArray(index)
      ? index
      : {};
  };

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
  /** In-memory only: the remote is not app state, and this is display context. */
  let lastFetchMs = 0;
  let fetchError = null;
  /** @type {Promise<string|null>|null} Why the fetch that is running will fail (null = fine). */
  let fetchInFlight = null;

  /** git's own marker files: a rebase/merge/cherry-pick left open in the clone. */
  const repoOperationOf = (repo) =>
    repoOperation({ repo, env: gitEnv(), run, existsSync, readText });

  /** The branch's tracking ref ("origin/main"), or null when it has none. */
  async function trackingRef(repo) {
    const r = await run(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      repo,
      gitEnv(),
    );
    const name = r.ok ? r.stdout.trim() : "";
    return name === "" || name === "@{upstream}" ? null : name;
  }

  /**
   * One fetch, no matter how many callers want it right now: `status` runs on a
   * timer and the Check button runs on a click.
   * @returns the error text, or null when the fetch worked.
   */
  const fetchUpstreamOnce = (repo, upstream) => {
    if (!fetchInFlight) {
      fetchInFlight = (async () => {
        const i = upstream.indexOf("/");
        // No --tags (one clashing local tag makes git refuse the whole fetch) and
        // no --prune: this brings one branch's ref up to date and touches nothing
        // else. remote/branch are git's own naming for a tracking ref.
        // shortcut: a clone with a custom fetch refspec would need
        // branch.<name>.remote instead; it would show up as a fetch error.
        const r =
          i > 0
            ? await run(
                "git",
                ["fetch", upstream.slice(0, i), upstream.slice(i + 1)],
                repo,
                gitEnv(),
                FETCH_TIMEOUT_MS,
              )
            : {
                ok: false,
                error: `Not a remote/branch tracking ref: ${upstream}`,
              };
        fetchError = r.ok ? null : r.error || "git fetch failed";
        lastFetchMs = Date.now();
        return fetchError;
      })().finally(() => {
        fetchInFlight = null;
      });
    }
    return fetchInFlight;
  };

  /**
   * What the tracking ref holds that HEAD does not and the other way round. Every
   * revision is the literal `@{upstream}` — no name from the renderer reaches git.
   */
  async function remoteFacts(repo, upstream) {
    const [counts, incoming, outgoing] = await Promise.all([
      run(
        "git",
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        repo,
        gitEnv(),
      ),
      run(
        "git",
        [
          "log",
          "--oneline",
          "-n",
          String(MAX_COMMIT_LINES),
          "HEAD..@{upstream}",
        ],
        repo,
        gitEnv(),
      ),
      run(
        "git",
        [
          "log",
          "--oneline",
          "-n",
          String(MAX_COMMIT_LINES),
          "@{upstream}..HEAD",
        ],
        repo,
        gitEnv(),
      ),
    ]);
    const lr = parseLeftRight(counts.stdout);
    return {
      newOnRemote: lr ? lr.right : null,
      unpushed: lr ? lr.left : null,
      newOnRemoteCommits: incoming.ok ? parseLogLines(incoming.stdout) : [],
      unpushedCommits: outgoing.ok ? parseLogLines(outgoing.stdout) : [],
      remoteError: lr
        ? null
        : counts.error || "git could not compare the branch with its upstream",
    };
  }

  /**
   * Installed build vs HEAD: the counts decide the sentence, and a list is only
   * asked for in the direction the counts say is non-empty. Listing `installed..HEAD`
   * alone — what this did first — read an installed build that was AHEAD of HEAD
   * as "matches the clone", because that range is then empty.
   */
  async function installedFacts(repo, installedSha) {
    const none = {
      installedRelation: "unknown",
      pendingCommits: [],
      pendingCommitsError: null,
      installedOnlyCommits: [],
      installedOnlyError: null,
      installedRelationError: null,
    };
    if (!installedSha) return none;
    const counts = await run(
      "git",
      ["rev-list", "--left-right", "--count", `${installedSha}...HEAD`],
      repo,
      gitEnv(),
    );
    const lr = parseLeftRight(counts.stdout);
    const list = (range) =>
      run(
        "git",
        ["log", "--oneline", "-n", String(MAX_COMMIT_LINES), range],
        repo,
        gitEnv(),
      );
    if (!lr) {
      // Includes an sha this clone does not contain: nothing may be claimed, and
      // the reason belongs with the sentence, not with one of the two lists.
      return {
        ...none,
        installedRelationError:
          counts.error || "git could not compare the installed build with HEAD",
      };
    }
    const [behind, ahead] = await Promise.all([
      lr.right > 0 ? list(`${installedSha}..HEAD`) : null,
      lr.left > 0 ? list(`HEAD..${installedSha}`) : null,
    ]);
    return {
      installedRelation: commitRelationship({ installedSha, counts: lr }),
      pendingCommits: behind?.ok ? parseLogLines(behind.stdout) : [],
      pendingCommitsError: behind?.ok
        ? null
        : behind?.error || "git could not list the commits",
      installedOnlyCommits: ahead?.ok ? parseLogLines(ahead.stdout) : [],
      installedOnlyError: ahead?.ok
        ? null
        : ahead?.error || "git could not list the commits",
    };
  }

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
      /** "same" | "behind" | "ahead" | "diverged" | "unknown" */
      installedRelation: "unknown",
      /** In HEAD, not in the installed build (max MAX_COMMIT_LINES). */
      pendingCommits: [],
      /** In the installed build, not in HEAD (max MAX_COMMIT_LINES). */
      installedOnlyCommits: [],
      /** Why the installed build could not be compared; display only. */
      installedRelationError: null,
      /** A git operation the clone is in the middle of: "rebase", "merge", … */
      gitOperation: null,
      // Display-only problems (listing commits) must not block Build.
      pendingCommitsError: null,
      installedOnlyError: null,
      /** e.g. "origin/main"; null when the branch does not track anything. */
      upstream: null,
      newOnRemote: null,
      unpushed: null,
      newOnRemoteCommits: [],
      unpushedCommits: [],
      remoteError: null,
      /** Why Pull is refused/disabled; null when it is a waiting fast-forward. */
      pullError: null,
      lastFetchMs: lastFetchMs || null,
      fetchError,
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
    const repo = out.repoPath;
    const [branch, head, porcelain, operation] = await Promise.all([
      run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo, gitEnv()),
      run("git", ["rev-parse", "HEAD"], repo, gitEnv()),
      run("git", ["status", "--porcelain"], repo, gitEnv()),
      repoOperationOf(repo),
    ]);
    if (!head.ok) {
      out.error = head.error;
      return out;
    }
    out.branch = branch.ok ? branch.stdout.trim() : null;
    out.headSha = head.stdout.trim();
    out.clean = porcelain.ok ? porcelain.stdout.trim() === "" : null;
    out.gitOperation = operation.operation;
    Object.assign(out, await installedFacts(repo, out.installedSha));

    out.upstream = await trackingRef(repo);
    // Status is on a 30 s timer, so the remote is only asked for once this window
    // has passed; the Check button forces it.
    if (
      out.upstream &&
      (lastFetchMs === 0 || Date.now() - lastFetchMs > FETCH_MAX_AGE_MS)
    ) {
      await fetchUpstreamOnce(repo, out.upstream);
      out.lastFetchMs = lastFetchMs || null;
      out.fetchError = fetchError;
    }
    // No tracking ref is a fact the card says so about, not a failure, so
    // remoteError keeps its null default in that case.
    if (out.upstream) Object.assign(out, await remoteFacts(repo, out.upstream));
    out.pullError = pullRefusal({
      clean: out.clean,
      buildRunning: build.running,
      operation: out.gitOperation,
      upstream: out.upstream,
      unpushed: out.unpushed,
      newOnRemote: out.newOnRemote,
    });
    return out;
  });

  // ── fetch / pull ────────────────────────────────────────────────────────────
  handle(CHANNEL.fetch, async () => {
    const repo = repoPath();
    if (!repo || !existsSync(repo))
      return { ok: false, error: "Clone path unavailable" };
    const upstream = await trackingRef(repo);
    if (!upstream) {
      fetchError = "This branch has no upstream tracking branch to fetch.";
      lastFetchMs = Date.now();
      return { ok: false, error: fetchError };
    }
    const error = await fetchUpstreamOnce(repo, upstream);
    return error ? { ok: false, error } : { ok: true };
  });

  /**
   * Pull = `git merge --ff-only @{upstream}`, and never anything else: no rebase,
   * no merge commit, no reset. The guards are re-read here rather than trusted
   * from the last status, and git itself still refuses a non-fast-forward — the
   * window between reading and merging is closed by git, not by us.
   */
  handle(CHANNEL.pull, async () => {
    if (!supported) return { ok: false, error: "Only supported on Windows" };
    const repo = repoPath();
    if (!repo || !existsSync(repo))
      return { ok: false, error: "Clone path unavailable" };
    const [porcelain, operation, upstream] = await Promise.all([
      run("git", ["status", "--porcelain"], repo, gitEnv()),
      repoOperationOf(repo),
      trackingRef(repo),
    ]);
    const clean = porcelain.ok ? porcelain.stdout.trim() === "" : null;
    const facts = upstream
      ? await remoteFacts(repo, upstream)
      : {
          newOnRemote: null,
          unpushed: null,
          newOnRemoteCommits: [],
          unpushedCommits: [],
        };
    const refusal = pullRefusal({
      clean,
      buildRunning: build.running,
      operation: operation.operation,
      upstream,
      unpushed: facts.unpushed,
      newOnRemote: facts.newOnRemote,
    });
    if (refusal) return { ok: false, error: refusal };
    const r = await run(
      "git",
      ["merge", "--ff-only", "@{upstream}"],
      repo,
      gitEnv(),
      PULL_TIMEOUT_MS,
    );
    return r.ok
      ? { ok: true, output: r.stdout.trim() }
      : { ok: false, error: r.error || "git merge --ff-only failed" };
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
        ).stdout.trim() || "0000000"; // placeholder still matches the archive-name pattern
      mkdirSync(archiveDir, { recursive: true });
      const name = archiveFileName(version, sha);
      const dest = join(archiveDir, name);
      copyFileSync(join(outDir, installer.name), dest);
      // Which branch each installer came from: pruning keeps the newest build
      // of the anchor branch (the fork's main) as the rollback point.
      const branch = (
        await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo)
      ).stdout.trim();
      const index = readArchiveIndex();
      index[name] = { branch: branch || null, builtMs: Date.now() };
      const anchorBranch = resolveSyncSettings(
        readJson(join(app.getPath("userData"), OVERRIDE_FILE)),
      ).syncBranch;
      // An unfinished upstream sync keeps the pre-sync anchor build too.
      const syncInFlight = Boolean(
        readJson(join(app.getPath("userData"), SYNC_STATE_FILE))?.sync,
      );
      for (const old of selectArchiveToPrune(listDir(archiveDir), {
        keepName: name,
        index,
        anchorBranch,
        anchorKeep: syncInFlight ? 2 : 1,
      })) {
        try {
          unlinkSync(join(archiveDir, old));
          delete index[old];
        } catch {
          // best-effort: an installer that is in use stays until the next build
        }
      }
      writeFileSync(
        join(archiveDir, ARCHIVE_INDEX_FILE),
        `${JSON.stringify(index, null, 2)}\n`,
        "utf8",
      );
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

  /**
   * The Build button's work: guard, run the build, archive the installer.
   * Shared with the upstream sync, which starts the same build after a clean
   * rebase (see ../upstream-sync.mjs) — behaviour must stay identical.
   */
  const startBuild = async () => {
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
    const command = buildCommand({
      installDependencies: needsDependencyInstall({
        lockMtimeMs: mtimeOf(join(repo, "package-lock.json")),
        installedLockMtimeMs: mtimeOf(
          join(repo, "node_modules", ".package-lock.json"),
        ),
      }),
    });
    pushLines([`> ${command}  (${repo})`]);

    return new Promise((resolvePromise) => {
      // shell:true — on Windows npm is npm.cmd, which spawn() will not run directly.
      const child = spawn(command, {
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
  };

  handle(CHANNEL.build, startBuild);

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
  const archiveEntries = () => {
    const index = readArchiveIndex();
    return sortArchive(listDir(archiveDir)).map((e) => ({
      path: join(archiveDir, e.name),
      name: e.name,
      mtimeMs: e.mtimeMs,
      size: e.size,
      branch: index[e.name]?.branch ?? null,
      ...parseArchiveFileName(e.name),
    }));
  };

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
    writeFileSync(scriptPath, `\uFEFF${INSTALL_HELPER_PS1}`, "utf8");
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
      HELPER_LAUNCH_TIMEOUT_MS,
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

  return {
    /** Same build the Build button runs (used by the upstream sync). */
    startBuild,
    isBuildRunning: () => build.running,
    /** When the current (or last) build started, 0 before the first one. */
    buildStartedMs: () => build.startedMs,
    /** Contents of electron/build-info.json, null when absent. */
    buildInfo,
    /** Which clone this app belongs to (override file wins over build time). */
    repoPath,
  };
}
