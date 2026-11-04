/**
 * In-app upstream sync (fork-only feature).
 *
 * The desktop app notices a newer upstream release, rebases the fork's sync
 * branch onto it, rebuilds itself with the existing build pipeline, and — after
 * that build has been installed — offers one guarded push to the fork.
 * Conflicts are not resolved here: they are handed to an agent CLI the user
 * picks, or to the user as a copyable task. The renderer drives it through the
 * `agentCanvasSelfUpdate` bridge in preload-main.cjs.
 *
 * State lives in `<userData>/upstream-sync.json`, so a sync survives the
 * quit-to-install that is part of finishing it.
 *
 * Security: the rules of self-update.mjs. Only the app's own main window is
 * answered; the renderer sends no commands, no paths and no branch/remote names
 * (those come from `<userData>/self-update.json` and are validated by
 * lib/upstream-sync-logic.mjs; tags come from `git tag --list` filtered to a
 * strict release pattern). git always runs through execFile with an argument
 * array, non-interactive (GIT_EDITOR=true, GIT_TERMINAL_PROMPT=0).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  AGENT_LAUNCHER_PS1,
  AGENT_WRAPPER_PS1,
} from "./lib/agent-launch-script.mjs";
import {
  TRANSLATION_FILE,
  mergeTranslations,
} from "./lib/translation-merge.mjs";
import {
  AGENT_LABELS,
  agentCommandLine,
  backupBranchName,
  branchFromHeadName,
  deriveSyncPhase,
  describeFetchFailure,
  discardedBackupRef,
  isBackupBranchName,
  isReleaseTag,
  isSafeRefName,
  newestReleaseTag,
  pushArgs,
  resolveSyncSettings,
  SYNC_STATE_FILE,
  syncTaskText,
} from "./lib/upstream-sync-logic.mjs";
import { isLoopbackAppUrl } from "./lib/window-url-policy.mjs";
import {
  OVERRIDE_FILE,
  getArchiveDir,
  onPath,
  readJson,
  readText,
  run,
} from "./self-update.mjs";

const CHANNEL = {
  check: "sync:check",
  start: "sync:start",
  agent: "sync:agent",
  abort: "sync:abort",
  discard: "sync:discard",
  push: "sync:push",
  state: "sync:state",
};

/** `git fetch` runs on an explicit Check, or when the last one is older. */
const FETCH_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const REBASE_TIMEOUT_MS = 10 * 60 * 1000;
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 30_000;
/** Lines of the agent's own log replayed to the panel. */
const AGENT_LOG_TAIL = 60;
/** Commit lines the Discard confirmation shows before it says "and more". */
const MAX_DISCARD_COMMITS = 20;

/**
 * @param {object} deps
 * @param {import("electron").App} deps.app
 * @param {import("electron").IpcMain} deps.ipcMain
 * @param {() => import("electron").BrowserWindow | null} deps.getMainWindow
 * @param {() => Promise<object>} deps.startBuild the Custom build card's build
 * @param {() => boolean} deps.isBuildRunning
 * @param {() => number} deps.buildStartedMs when the current or last build started
 * @param {() => object | null} deps.buildInfo electron/build-info.json
 * @param {() => string | null} deps.repoPath the clone this app was built from
 */
export function registerUpstreamSync({
  app,
  ipcMain,
  getMainWindow,
  startBuild,
  isBuildRunning,
  buildStartedMs,
  buildInfo,
  repoPath,
}) {
  const archiveDir = getArchiveDir();
  const supported = process.platform === "win32";
  const statePath = join(app.getPath("userData"), SYNC_STATE_FILE);
  /** True while a sync mutation is in flight (best-effort double-click guard). */
  let busy = false;
  /** True from the moment the sync asks for a build until it is really done. */
  let buildPending = false;
  /** Why the build the last clean rebase started did not run (null = fine). */
  let autoBuildError = null;
  /**
   * When that refusal happened. A build that started afterwards (either button)
   * answers the same question better, so the refusal stops being reported then.
   */
  let autoBuildErrorMs = 0;

  const trusted = (event) => {
    const win = getMainWindow();
    return Boolean(
      win &&
      !win.isDestroyed() &&
      event.sender === win.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      isLoopbackAppUrl(event.senderFrame?.url),
    );
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

  // ── state + settings ────────────────────────────────────────────────────────
  // { lastFetchMs, lastCheckError,
  //   sync: { latestTag, backupBranch, originSha, startedMs, pushed, agent } | null }
  const readState = () => {
    const s = readJson(statePath);
    return s && typeof s === "object" ? s : {};
  };

  /** False when the file cannot be written — the caller must then not proceed. */
  const saveState = (state) => {
    try {
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  };

  const clearSync = () => {
    const state = readState();
    state.sync = null;
    // A sync that is over has no build to report on: the refused-auto-build note
    // must not follow the user into the next phase of the panel.
    autoBuildError = null;
    saveState(state);
  };

  const settings = () =>
    resolveSyncSettings(readJson(join(app.getPath("userData"), OVERRIDE_FILE)));

  /** The clone, or null when it is not reachable. */
  const clone = () => {
    const repo = repoPath();
    return repo && existsSync(repo) ? repo : null;
  };

  // ── git facts ───────────────────────────────────────────────────────────────

  /** A non-interactive environment for every git call. */
  const gitEnv = () => ({
    ...process.env,
    GIT_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
  });

  /** A tag name may only ever be one of ours before it reaches git. */
  const safeTag = (tag) => (isReleaseTag(tag) ? String(tag).trim() : null);

  /**
   * `git rev-parse --git-path <key>`, as an absolute path (git prints one that is
   * relative to the clone). "" when it cannot answer.
   */
  async function gitPath(repo, key) {
    const r = await run(
      "git",
      ["rev-parse", "--git-path", key],
      repo,
      gitEnv(),
    );
    const path = r.ok ? r.stdout.trim() : "";
    if (!path) return "";
    return isAbsolute(path) ? path : join(repo, path);
  }

  /**
   * git's own rebase state. While a rebase is stopped, `HEAD` is detached, so the
   * branch it was started on only exists in the `head-name` file git keeps
   * (`refs/heads/<branch>`).
   */
  async function rebaseState(repo) {
    for (const key of ["rebase-merge", "rebase-apply"]) {
      const dir = await gitPath(repo, key);
      if (!dir || !existsSync(dir)) continue;
      return {
        paused: true,
        branch: branchFromHeadName(readText(join(dir, "head-name"))),
      };
    }
    return { paused: false, branch: null };
  }

  /** `merge-base --is-ancestor`; false for "no" and for an unknown revision. */
  async function isAncestor(repo, ancestor, descendant) {
    const r = await run(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      repo,
      gitEnv(),
    );
    return r.ok;
  }

  /**
   * Everything the rules and the panel need, read from the clone right now.
   * @param {string|null} targetTag the tag a running sync is rebasing onto
   */
  async function collectFacts(repo, targetTag = null) {
    const s = settings();
    const [branchRes, headRes, statusRes, tagRes, baseRes, countRes] =
      await Promise.all([
        run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo, gitEnv()),
        run("git", ["rev-parse", "HEAD"], repo, gitEnv()),
        run("git", ["status", "--porcelain"], repo, gitEnv()),
        run(
          "git",
          ["tag", "--list", "v*", "--merged", `${s.upstreamRemote}/main`],
          repo,
          gitEnv(),
        ),
        run(
          "git",
          ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"],
          repo,
          gitEnv(),
        ),
        run(
          "git",
          [
            "rev-list",
            "--count",
            s.syncBranch,
            "--not",
            `--remotes=${s.upstreamRemote}`,
          ],
          repo,
          gitEnv(),
        ),
      ]);

    // A tag the fork made itself must never become a sync target, so the list is
    // limited to what is merged into the upstream remote's main line. When that
    // ref is unknown (a clone that has not fetched it) every v* tag is used.
    // The price: a maintenance release cut on a branch that never lands on main
    // (a 1.35.x line after 1.36) is invisible here too — that is the safer side.
    const tagList = tagRes.ok
      ? tagRes
      : await run("git", ["tag", "--list", "v*"], repo, gitEnv());
    const latestTag = newestReleaseTag(tagList.stdout.split(/\r?\n/));
    const rebase = await rebaseState(repo);
    // While a rebase is paused, HEAD is detached, so the branch comes from git's
    // own rebase state; `rev-parse --abbrev-ref HEAD` only says "HEAD" there.
    const branch = rebase.paused
      ? rebase.branch
      : branchRes.ok
        ? branchRes.stdout.trim()
        : null;
    const conflictedFiles = rebase.paused
      ? (
          await run(
            "git",
            ["diff", "--name-only", "--diff-filter=U"],
            repo,
            gitEnv(),
          )
        ).stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

    const target = safeTag(targetTag) ?? latestTag;
    const containsLatest = latestTag
      ? await isAncestor(repo, latestTag, s.syncBranch)
      : false;
    const containsTarget =
      target === latestTag
        ? containsLatest
        : target
          ? await isAncestor(repo, target, s.syncBranch)
          : false;

    return {
      repoPath: repo,
      settings: s,
      branch,
      headSha: headRes.ok ? headRes.stdout.trim() : null,
      onSyncBranch: branch === s.syncBranch,
      clean: statusRes.ok ? statusRes.stdout.trim() === "" : null,
      latestTag,
      // The release the clone sits on (display only: describe can return an
      // odd tag like v1.23.0-r2, which is exactly what the user should see).
      cloneBaseTag: baseRes.ok ? baseRes.stdout.trim() || null : null,
      forkCommitCount: countRes.ok
        ? Number.parseInt(countRes.stdout.trim(), 10)
        : null,
      rebaseInProgress: rebase.paused,
      conflictedFiles,
      updateAvailable: latestTag ? !containsLatest : false,
      branchContainsTarget: containsTarget,
      error: branchRes.ok ? null : branchRes.error,
    };
  }

  /**
   * Alive? Signal 0 changes nothing, it only runs the existence check: ESRCH
   * means the process is gone, EPERM means it exists but is not ours. The PID is
   * the agent wrapper's, which lives exactly as long as the agent (see
   * lib/agent-launch-script.mjs), so this is the agent's real state.
   */
  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === "EPERM";
    }
  }

  /**
   * What a Discard would drop: the commits on HEAD that are not in the backup
   * branch. Read-only, capped at MAX_DISCARD_COMMITS lines; null when there is no
   * backup branch we generated (then Discard is refused anyway).
   */
  async function discardPreview(repo, state) {
    const backup = state.sync?.backupBranch;
    if (!isBackupBranchName(backup)) return null;
    const r = await run(
      "git",
      ["log", "--oneline", `-${MAX_DISCARD_COMMITS + 1}`, `${backup}..HEAD`],
      repo,
      gitEnv(),
    );
    if (!r.ok) return null;
    const lines = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      backupBranch: backup,
      discardedBranch: safeDiscardedBranch(state),
      commits: lines.slice(0, MAX_DISCARD_COMMITS),
      truncated: lines.length > MAX_DISCARD_COMMITS,
    };
  }

  /**
   * The branch Discard will park the rolled-back commits on, from the sync record.
   * A sync started before this existed has no name, so the preview and the reset
   * both say so instead of promising a branch nobody will create.
   */
  function safeDiscardedBranch(state) {
    const name = state.sync?.discardedBranch;
    return typeof name === "string" && isSafeRefName(name) ? name : null;
  }

  /** Last `max` non-empty lines of a log file. */
  function logTail(path, max = AGENT_LOG_TAIL) {
    const lines = readText(path).split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1].trim() === "")
      lines.pop();
    return lines.slice(-max);
  }

  // ── the payload sync:check and sync:state both return ───────────────────────

  const NO_CLONE = {
    repoPath: null,
    branch: null,
    headSha: null,
    onSyncBranch: false,
    clean: null,
    latestTag: null,
    cloneBaseTag: null,
    forkCommitCount: null,
    rebaseInProgress: false,
    conflictedFiles: [],
    updateAvailable: false,
    branchContainsTarget: false,
    error:
      "Clone not found: this app was not built with build-info, and no repoPath override is set.",
  };

  async function buildPayload(state, repo) {
    const info = buildInfo();
    const agent = state.sync?.agent ?? null;
    const agentRunning = agent ? pidAlive(agent.pid) : false;
    const installedSha = info?.commitSha ?? null;
    const facts = repo ?? { ...NO_CLONE, settings: settings() };
    return {
      ok: true,
      supported,
      packaged: app.isPackaged,
      gitFound: await onPath("git"),
      agents: {
        opencode: await onPath("opencode"),
        claude: await onPath("claude"),
      },
      settings: facts.settings,
      state: state.sync ?? null,
      installedUpstreamTag: info?.upstreamTag ?? null,
      installedSha,
      buildTime: info?.buildTime ?? null,
      lastCheckError: state.lastCheckError ?? null,
      lastFetchMs: state.lastFetchMs ?? null,
      // Display only: the push that ended the last sync.
      lastSync: state.lastSync ?? null,
      // Display only: what the i18n auto-merge did for this sync (null = it never ran).
      autoMerge: state.sync?.autoMerge ?? null,
      // A refused auto-build is worth repeating only until the next build attempt:
      // any build that started after it (either button) answers the same question.
      autoBuildError:
        autoBuildError && buildStartedMs() <= autoBuildErrorMs
          ? autoBuildError
          : null,
      // `buildPending` covers the moment between asking for the build and the
      // build process actually existing, so the panel never shows a gap.
      building: isBuildRunning() || buildPending,
      agent: agent
        ? {
            kind: agent.kind,
            label: AGENT_LABELS[agent.kind] ?? agent.kind,
            pid: agent.pid,
            running: agentRunning,
            logPath: agent.logPath,
            log: logTail(agent.logPath),
            errLog: logTail(agent.errLogPath, 20),
          }
        : null,
      ...facts,
      taskText:
        repo && state.sync && safeTag(state.sync.latestTag)
          ? syncTaskText({
              // `repo` is the clone path; `repoPath` is the same string inside the
              // facts object. Passing the object printed as [object Object].
              repoPath: facts.repoPath,
              branch: facts.settings.syncBranch,
              targetTag: state.sync.latestTag,
              backupBranch: state.sync.backupBranch ?? "",
              conflictedFiles: facts.conflictedFiles,
            })
          : "",
    };
  }

  /** Phase from the state file plus what git says right now. */
  function phaseOf(state, facts, gitFound) {
    return deriveSyncPhase({
      state: state.sync ?? null,
      repo: {
        gitFound,
        repoPath: facts.repoPath,
        onSyncBranch: facts.onSyncBranch,
        rebaseInProgress: facts.rebaseInProgress,
        clean: facts.clean,
        branchContainsTarget: facts.branchContainsTarget,
        installedSha: buildInfo()?.commitSha ?? null,
        headSha: facts.headSha,
        updateAvailable: facts.updateAvailable,
      },
    });
  }

  /** Shared tail of check/state: payload plus the derived phase. */
  async function payloadFor(state, repo) {
    let current = state;
    let facts = await collectFacts(repo, current.sync?.latestTag ?? null);
    // The rebase was finished or rolled back outside the app: a record that no
    // longer matches the branch would offer actions for a sync that is gone. Never
    // while a mutation of ours is in flight (sync:start records before it rebases).
    let recordCleared = false;
    let clearedBackup = null;
    if (
      current.sync &&
      !busy &&
      !facts.rebaseInProgress &&
      !facts.branchContainsTarget
    ) {
      // The record is gone after clearSync, so keep the one fact the user needs:
      // the backup branch that still holds where the branch stood before.
      clearedBackup = current.sync.backupBranch ?? null;
      clearSync();
      current = { ...current, sync: null };
      recordCleared = true;
      facts = await collectFacts(repo, null);
    }
    // The same resolver the Start button runs, so opening the panel while a rebase is stopped on the
    // i18n file alone finishes it instead of asking for help. Never while an agent works the
    // conflicts: it may be mid-edit, and its task text tells it to run the same CLI itself.
    if (
      repo &&
      !busy &&
      facts.rebaseInProgress &&
      facts.conflictedFiles.includes(TRANSLATION_FILE) &&
      !pidAlive(current.sync?.agent?.pid ?? 0)
    ) {
      if (await autoResolveTranslations(repo)) {
        current = readState();
        facts = await collectFacts(repo, current.sync?.latestTag ?? null);
      }
    }
    const payload = await buildPayload(current, facts);
    return {
      ...payload,
      phase: phaseOf(current, facts, payload.gitFound),
      syncRecordCleared: recordCleared,
      clearedBackup,
      discardPreview: current.sync ? await discardPreview(repo, current) : null,
    };
  }

  // ── check / state ───────────────────────────────────────────────────────────

  handle(CHANNEL.state, async () => {
    const state = readState();
    const repo = clone();
    if (!repo) {
      const payload = await buildPayload(state, null);
      return {
        ...payload,
        ...NO_CLONE,
        syncRecordCleared: false,
        discardPreview: null,
        phase: phaseOf(
          state,
          { ...NO_CLONE, settings: settings() },
          await onPath("git"),
        ),
      };
    }
    return payloadFor(state, repo);
  });

  /** `git fetch` the upstream tags; returns the error text or null. */
  function fetchUpstream(repo, s) {
    return run(
      "git",
      // An explicit v* refspec, not --tags. With --tags a local tag of the same
      // name (a re-cut release, a fork tag that reuses an upstream version) makes
      // git refuse the whole fetch, and then no new release tag arrives at all.
      // The colon form only ever writes refs/tags/v*, so fork-only and other local
      // tags are out of reach, and no --prune: that would delete tags upstream
      // does not carry. Upstream's main comes along: the release list is the
      // v* tags merged into <upstreamRemote>/main, so that ref must be fresh too.
      [
        "fetch",
        s.upstreamRemote,
        "+refs/tags/v*:refs/tags/v*",
        `+refs/heads/main:refs/remotes/${s.upstreamRemote}/main`,
      ],
      repo,
      gitEnv(),
      FETCH_TIMEOUT_MS,
    ).then((r) => (r.ok ? null : describeFetchFailure(r.error)));
  }

  handle(CHANNEL.check, async (force) => {
    const state = readState();
    const repo = clone();
    if (!repo) return { ok: false, error: NO_CLONE.error };
    // Fetch on an explicit Check or when the last one has gone stale: the only
    // thing that talks to GitHub.
    const stale =
      !state.lastFetchMs || Date.now() - state.lastFetchMs > FETCH_MAX_AGE_MS;
    let checkError = state.lastCheckError ?? null;
    if (force === true || stale) {
      checkError = await fetchUpstream(repo, settings());
      // Re-read before saving: the fetch is an await, and a sync handler may have
      // written a record while it ran. Only the two fetch fields are set on the
      // fresh copy, so anything written during the fetch survives this write.
      const fresh = readState();
      fresh.lastFetchMs = Date.now();
      fresh.lastCheckError = checkError;
      saveState(fresh);
    }
    const payload = await payloadFor(readState(), repo);
    return { ...payload, checkError };
  });

  // ── sync ────────────────────────────────────────────────────────────────────

  /** Guards shared by every mutation; returns an error string or null. */
  async function mutationError({
    needRebase = false,
    needNotPushed = false,
  } = {}) {
    if (!supported) return "Only supported on Windows";
    if (!app.isPackaged) return "Sync is only available in the installed app";
    if (isBuildRunning()) return "A build is running";
    if (busy) return "Another sync action is still running";
    const repo = clone();
    if (!repo) return NO_CLONE.error;
    const facts = await collectFacts(repo);
    if (facts.error) return facts.error;
    if (!facts.onSyncBranch) {
      return `The clone is on ${facts.branch ?? "a detached HEAD"}, not on ${facts.settings.syncBranch}`;
    }
    if (needRebase && !facts.rebaseInProgress)
      return "No rebase is in progress";
    if (!needRebase && facts.rebaseInProgress) {
      return "A rebase is in progress — resolve or abort it first";
    }
    if (needNotPushed && readState().sync?.pushed) {
      return "This sync has already been pushed";
    }
    return null;
  }

  /** Refuse to start or abort over a conflict agent that is still alive. */
  async function agentRunningError(state) {
    const agent = state.sync?.agent;
    if (agent && pidAlive(agent.pid)) {
      return `${AGENT_LABELS[agent.kind] ?? agent.kind} is still running (pid ${agent.pid})`;
    }
    return null;
  }

  handle(CHANNEL.start, async () => {
    const base = await mutationError();
    if (base) return { ok: false, error: base };
    const repo = clone();
    const s = settings();
    const state = readState();
    if (state.sync) {
      return {
        ok: false,
        error: "A sync is already in flight — push it or discard it first.",
      };
    }
    busy = true;
    try {
      const fetchError = await fetchUpstream(repo, s);
      const facts = await collectFacts(repo);
      if (!facts.latestTag) {
        return {
          ok: false,
          error: `No release tags (v*) in the clone.${fetchError ? ` Fetch also failed: ${fetchError}` : ""}`,
        };
      }
      if (facts.clean !== true) {
        return { ok: false, error: "The working tree has uncommitted changes" };
      }
      if (!facts.updateAvailable) {
        return {
          ok: false,
          error: `${facts.latestTag} is already in ${s.syncBranch}.`,
        };
      }
      // What the fork holds now: the force-with-lease target after the rebase.
      const remoteRef = await run(
        "git",
        ["rev-parse", "--verify", "--quiet", `${s.forkRemote}/${s.syncBranch}`],
        repo,
        gitEnv(),
      );
      const backupBranch = backupBranchName(s.syncBranch);
      const backup = await run("git", ["branch", backupBranch], repo, gitEnv());
      if (!backup.ok) return { ok: false, error: backup.error };
      // Written before the rebase: once the branch moves, this record and the
      // backup branch are the only way back. The copy is read NOW — after the
      // fetch above — for the same reason sync:check re-reads before saving: the
      // state may have changed while this handler was awaiting.
      if (
        !saveState({
          ...readState(),
          sync: {
            latestTag: facts.latestTag,
            backupBranch,
            // Name chosen now so the Discard preview can promise it and the reset
            // can keep to it; the ref itself is only created if the user discards.
            discardedBranch: discardedBackupRef(s.syncBranch),
            originSha: remoteRef.ok ? remoteRef.stdout.trim() : null,
            startedMs: Date.now(),
            pushed: false,
            agent: null,
            fetchError,
          },
        })
      ) {
        return {
          ok: false,
          error: `Could not write ${statePath} — refusing to rebase without a record of the backup branch.`,
        };
      }

      const rebase = await run(
        "git",
        ["rebase", facts.latestTag],
        repo,
        gitEnv(),
        REBASE_TIMEOUT_MS,
      );
      let after = await collectFacts(repo, facts.latestTag);
      // Every sync of this fork stops on one file (the i18n file both sides append to). Take it out
      // of the way before deciding the rebase needs a human.
      const autoMerge = after.rebaseInProgress
        ? await autoResolveTranslations(repo)
        : null;
      if (autoMerge) after = await collectFacts(repo, facts.latestTag);
      if (after.rebaseInProgress) {
        // Conflicts: the rebase stays paused for the agent or the user.
        return {
          ok: true,
          phase: "conflict",
          conflictedFiles: after.conflictedFiles,
          targetTag: facts.latestTag,
          backupBranch,
          error: fetchError,
          autoMerge,
          // No build: the branch is mid-rebase, so the Build card must stay as it was.
          buildStarted: false,
        };
      }
      // `rebase.ok` is false whenever git stopped for a conflict — including one this resolver just
      // cleared. Only a branch that still does not hold the target really failed.
      if (!rebase.ok && !after.branchContainsTarget) {
        // Never got as far as pausing: drop the record so the panel does not
        // offer actions for a sync that did not happen. The backup branch
        // stays behind (harmless, and it is the recovery point if git moved
        // the branch before failing).
        clearSync();
        return {
          ok: false,
          error: `git rebase ${facts.latestTag} failed: ${rebase.error}`,
        };
      }
      // Clean rebase: the same build the Build button runs. It keeps running if
      // this window navigates away; the card re-adopts it through status().
      buildPending = true;
      autoBuildError = null;
      void Promise.resolve(startBuild())
        .then((result) => {
          // The card shows a build that ran; this is for the ones that never
          // started (guards in self-update.mjs), which nothing else would report.
          if (result && result.ok === false) {
            autoBuildError = result.error ?? "the build did not start";
            autoBuildErrorMs = Date.now();
          }
        })
        .finally(() => {
          buildPending = false;
        });
      return {
        ok: true,
        phase: "rebased",
        targetTag: facts.latestTag,
        backupBranch,
        error: fetchError,
        autoMerge,
        // The card may show "Building..." only when a build really was asked for.
        buildStarted: true,
      };
    } finally {
      busy = false;
    }
  });

  // ── the i18n file every sync conflicts on ───────────────────────────────────

  /**
   * How many times one sync may auto-resolve the translation file. A rebase replays one commit at a
   * time, so the file can conflict once per replayed fork commit; the fork has a handful. More than
   * this means git is not making progress, which is a bug to stop on rather than spin over.
   */
  const MAX_AUTO_RESOLVE_STEPS = 50;

  /** Conflicted files of a paused rebase; [] when git cannot answer. */
  async function conflictedList(repo) {
    const r = await run(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      repo,
      gitEnv(),
    );
    return r.ok
      ? r.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  }

  /**
   * Merge the file's three index stages with the same function the CLI uses
   * (`scripts/resolve-translation-conflict.mjs`) and stage the result, so the app, an agent and a
   * human at a terminal always reach the same answer.
   */
  async function mergeTranslationFile(repo) {
    const [base, ours, theirs] = await Promise.all(
      [1, 2, 3].map((stage) =>
        run("git", ["show", `:${stage}:${TRANSLATION_FILE}`], repo, gitEnv()),
      ),
    );
    // No stage 2 or 3 means one side deleted the file as a whole: a human decision, not a key merge.
    if (!ours.ok || !theirs.ok) {
      return {
        ok: false,
        keys: 0,
        conflicts: [],
        error:
          "one side has no version of the file (it was added or deleted as a whole)",
      };
    }
    const merged = mergeTranslations(
      base.ok ? base.stdout : null,
      ours.stdout,
      theirs.stdout,
    );
    if (!merged.ok) {
      return {
        ok: false,
        keys: 0,
        conflicts: merged.conflicts,
        error: merged.error,
      };
    }
    try {
      writeFileSync(join(repo, TRANSLATION_FILE), merged.text, "utf8");
    } catch (err) {
      return {
        ok: false,
        keys: 0,
        conflicts: [],
        error: `writing the merged file failed: ${err.message}`,
      };
    }
    const staged = await run(
      "git",
      ["add", "--", TRANSLATION_FILE],
      repo,
      gitEnv(),
    );
    if (!staged.ok) {
      return {
        ok: false,
        keys: 0,
        conflicts: [],
        error: `git add failed: ${staged.error}`,
      };
    }
    return {
      ok: true,
      keys: merged.added.length + merged.changed.length,
      conflicts: [],
      error: null,
    };
  }

  /**
   * Resolve that file at every stop of a paused rebase, and keep the rebase moving while it is the
   * ONLY conflict. Anything else leaves the rebase stopped where it is, for the agent or the user:
   * this never resolves a real code conflict, and never continues past one.
   *
   * Returns null when there was nothing of ours to do, so callers do not show a notice for a sync
   * that never touched the file.
   */
  async function autoResolveTranslations(repo) {
    if (!repo) return null;
    const summary = { stops: 0, keys: 0, conflicts: [], error: null, ms: 0 };
    const started = Date.now();
    for (let step = 0; step < MAX_AUTO_RESOLVE_STEPS; step += 1) {
      const files = await conflictedList(repo);
      if (!files.includes(TRANSLATION_FILE)) break;
      const merged = await mergeTranslationFile(repo);
      if (!merged.ok) {
        summary.conflicts = merged.conflicts;
        summary.error = merged.error;
        break;
      }
      summary.stops += 1;
      summary.keys += merged.keys;
      // Another file still conflicts: stopping the rebase there is correct, this only clears the tail.
      if (files.length > 1) break;
      const next = await run(
        "git",
        ["rebase", "--continue"],
        repo,
        gitEnv(),
        REBASE_TIMEOUT_MS,
      );
      if (!next.ok) {
        summary.error = `git rebase --continue failed: ${next.error}`;
        break;
      }
      if (!(await rebaseState(repo)).paused) break;
    }
    if (!summary.stops && !summary.conflicts.length && !summary.error)
      return null;

    summary.ms = Date.now() - started;
    const fresh = readState();
    if (fresh.sync) {
      saveState({
        ...fresh,
        sync: { ...fresh.sync, autoMerge: summary },
      });
    }
    return summary;
  }

  // ── conflicts ───────────────────────────────────────────────────────────────

  handle(CHANNEL.agent, async (kind) => {
    const base = await mutationError({ needRebase: true });
    if (base) return { ok: false, error: base };
    const repo = clone();
    const state = readState();
    if (!state.sync || !safeTag(state.sync.latestTag)) {
      return { ok: false, error: "No sync is in flight" };
    }
    const running = await agentRunningError(state);
    if (running) return { ok: false, error: running };
    const facts = await collectFacts(repo, state.sync.latestTag);
    const stamp = Date.now();
    const taskPath = join(archiveDir, `sync-task-${stamp}.md`);
    const argsPath = join(archiveDir, `sync-agent-${stamp}.args.txt`);
    const logPath = join(archiveDir, `sync-agent-${stamp}.log`);
    const errLogPath = join(archiveDir, `sync-agent-${stamp}.err.log`);
    const wrapperPath = join(archiveDir, `sync-agent-${stamp}.wrapper.ps1`);
    const line = agentCommandLine({
      kind,
      model: facts.settings.opencodeModel,
      taskFile: taskPath,
    });
    if (!line) return { ok: false, error: `Unknown agent ${String(kind)}` };
    if (!(await onPath(line.exe))) {
      return { ok: false, error: `${line.exe} was not found on PATH` };
    }
    busy = true;
    try {
      try {
        mkdirSync(archiveDir, { recursive: true });
        // Plain UTF-8: an agent reads this file, not PowerShell.
        writeFileSync(
          taskPath,
          syncTaskText({
            repoPath: repo,
            branch: facts.settings.syncBranch,
            targetTag: state.sync.latestTag,
            backupBranch: state.sync.backupBranch ?? "",
            conflictedFiles: facts.conflictedFiles,
          }),
          "utf8",
        );
        writeFileSync(argsPath, `${line.args.join("\n")}\n`, "utf8");
        // Fixed text: it carries no data, the launcher hands it the paths.
        writeFileSync(wrapperPath, AGENT_WRAPPER_PS1, "utf8");
      } catch (err) {
        return {
          ok: false,
          error: `Could not write the task file: ${err?.message ?? err}`,
        };
      }
      const launched = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          AGENT_LAUNCHER_PS1,
        ],
        undefined,
        {
          ...process.env,
          AC_AGENT_WRAPPER: wrapperPath,
          AC_AGENT_EXE: line.exe,
          AC_AGENT_ARGS_FILE: argsPath,
          AC_AGENT_CWD: repo,
          AC_AGENT_LOG: logPath,
          AC_AGENT_ERR_LOG: errLogPath,
        },
        LAUNCH_TIMEOUT_MS,
      );
      const pid = Number.parseInt(launched.stdout.trim(), 10);
      const errTail = logTail(errLogPath, 20);
      if (!launched.ok || !Number.isInteger(pid) || pid <= 0) {
        // The wrapper can also die on its own right after printing the PID (a bad
        // argument, a console that would not open). Store the record anyway: the
        // panel then shows the agent block with both log tails, marked not
        // running, and the error quotes the error log so the reason is readable
        // without opening files.
        const dead = readState();
        if (dead.sync) {
          dead.sync.agent = {
            kind,
            pid: null,
            taskPath,
            argsPath,
            wrapperPath,
            logPath,
            errLogPath,
            startedMs: Date.now(),
          };
          saveState(dead);
        }
        const why = launched.error || launched.stdout.trim() || "no PID";
        return {
          ok: false,
          error: `Could not start ${line.exe}: ${why}${
            errTail ? `\n${line.exe} error log:\n${errTail}` : ""
          }`,
        };
      }
      const fresh = readState();
      if (fresh.sync) {
        fresh.sync.agent = {
          kind,
          pid,
          taskPath,
          argsPath,
          wrapperPath,
          logPath,
          errLogPath,
          startedMs: Date.now(),
        };
        saveState(fresh);
      }
      return { ok: true, pid, logPath, taskPath };
    } finally {
      busy = false;
    }
  });

  handle(CHANNEL.abort, async () => {
    const base = await mutationError({ needRebase: true });
    if (base) return { ok: false, error: base };
    const running = await agentRunningError(readState());
    if (running) return { ok: false, error: running };
    const r = await run("git", ["rebase", "--abort"], clone(), gitEnv());
    if (!r.ok) return { ok: false, error: r.error };
    clearSync();
    return { ok: true };
  });

  // ── after the rebase ────────────────────────────────────────────────────────

  handle(CHANNEL.discard, async () => {
    const base = await mutationError({ needNotPushed: true });
    if (base) return { ok: false, error: base };
    const backup = readState().sync?.backupBranch;
    if (!isBackupBranchName(backup)) {
      return {
        ok: false,
        error: "No backup branch was recorded for this sync",
      };
    }
    const repo = clone();
    const exists = await run(
      "git",
      ["rev-parse", "--verify", "--quiet", backup],
      repo,
      gitEnv(),
    );
    if (!exists.ok) {
      return { ok: false, error: `Backup branch ${backup} no longer exists` };
    }
    // The reset would otherwise leave the sync's commits in the reflog only: park
    // them on the branch the preview named, and refuse to roll back without it.
    const parked = safeDiscardedBranch(readState());
    if (!parked) {
      return {
        ok: false,
        error:
          "This sync has no branch recorded for keeping the discarded commits — delete the commits by hand instead of using Discard",
      };
    }
    const head = await run("git", ["rev-parse", "HEAD"], repo, gitEnv());
    if (!head.ok) return { ok: false, error: head.error };
    const keep = await run(
      "git",
      ["branch", parked, head.stdout.trim()],
      repo,
      gitEnv(),
    );
    if (!keep.ok) {
      return {
        ok: false,
        error: `Could not keep the discarded commits on ${parked}: ${keep.error}`,
      };
    }
    // --keep refuses to clobber local changes (unlike --hard), so a dirty tree
    // fails here with git's own message instead of losing work.
    const r = await run("git", ["reset", "--keep", backup], repo, gitEnv());
    if (!r.ok) return { ok: false, error: r.error };
    clearSync();
    return { ok: true, backupBranch: backup, discardedBranch: parked };
  });

  handle(CHANNEL.push, async () => {
    const base = await mutationError({ needNotPushed: true });
    if (base) return { ok: false, error: base };
    const state = readState();
    if (!safeTag(state.sync?.latestTag)) {
      return { ok: false, error: "No sync is in flight" };
    }
    const repo = clone();
    const facts = await collectFacts(repo, state.sync.latestTag);
    if (!facts.branchContainsTarget) {
      return {
        ok: false,
        error: `${state.sync.latestTag} is not in ${facts.settings.syncBranch} yet`,
      };
    }
    if (facts.clean !== true) {
      return { ok: false, error: "The working tree has uncommitted changes" };
    }
    const installedSha = buildInfo()?.commitSha ?? null;
    if (!installedSha || installedSha !== facts.headSha) {
      return {
        ok: false,
        error:
          "This build does not run the rebased clone — build and install it first",
      };
    }
    // The lease is only as good as what the fork holds now, so read it again and
    // refuse if it moved. The lease itself is never refreshed: that would push over
    // whatever someone else put there.
    const fetched = await run(
      "git",
      ["fetch", facts.settings.forkRemote, facts.settings.syncBranch],
      repo,
      gitEnv(),
      PUSH_TIMEOUT_MS,
    );
    // A branch that is not on the fork yet cannot be fetched: that is exactly the
    // case originSha was recorded as null for, so only a failed fetch with a
    // recorded sha is fatal.
    if (!fetched.ok && state.sync.originSha) {
      return {
        ok: false,
        error: `Could not read ${facts.settings.forkRemote}/${facts.settings.syncBranch}: ${fetched.error}`,
      };
    }
    const remoteNow = await run(
      "git",
      [
        "rev-parse",
        "--verify",
        "--quiet",
        `${facts.settings.forkRemote}/${facts.settings.syncBranch}`,
      ],
      repo,
      gitEnv(),
    );
    const nowSha = remoteNow.ok ? remoteNow.stdout.trim() || null : null;
    if (nowSha !== (state.sync.originSha ?? null)) {
      return {
        ok: false,
        error: `the fork's ${facts.settings.syncBranch} moved since the sync started: ${state.sync.originSha ?? "(no branch)"}..${nowSha ?? "(no branch)"}; nothing was pushed`,
      };
    }
    const args = pushArgs({
      forkRemote: facts.settings.forkRemote,
      branch: facts.settings.syncBranch,
      expectedRemoteSha: state.sync.originSha,
    });
    if (!args)
      return { ok: false, error: "The push command could not be built" };
    const r = await run("git", args, repo, gitEnv(), PUSH_TIMEOUT_MS);
    if (!r.ok) return { ok: false, error: r.error };
    // M5: the push ends the sync. Keep a display-only record; the sync record goes,
    // so the next upstream release can start a fresh one and no action is offered
    // for a sync that is finished. The backup branch stays as the way back.
    const after = readState();
    after.sync = null;
    after.lastSync = {
      tag: state.sync.latestTag,
      pushedMs: Date.now(),
      backupBranch: state.sync.backupBranch ?? null,
      // The row is only about the branch this clone is on; another sync branch
      // (feature branches are rebased by hand) must not show it.
      branch: facts.settings.syncBranch,
    };
    saveState(after);
    return {
      ok: true,
      pushedTo: facts.settings.forkRemote,
      tag: state.sync.latestTag,
    };
  });
}
