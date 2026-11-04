/**
 * Renderer-side view of the fork-only desktop self-update bridge — see
 * electron/preload-main.cjs and electron/self-update.mjs. Absent in a browser
 * tab, so callers must treat `undefined` as "feature not available".
 */

export interface SelfUpdateBuildResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  installerPath?: string;
  version?: string;
  sha?: string;
}

/** How the installed build relates to the clone's HEAD (`ahead` = the build has
 * commits HEAD does not, e.g. it was built from a feature branch). */
export type InstalledRelation =
  | "same"
  | "behind"
  | "ahead"
  | "diverged"
  | "unknown";

export interface SelfUpdateStatus {
  ok: boolean;
  error: string | null;
  supported: boolean;
  packaged: boolean;
  repoPath: string | null;
  installedSha: string | null;
  installedBranch: string | null;
  buildTime: string | null;
  gitFound: boolean;
  npmFound: boolean;
  branch: string | null;
  headSha: string | null;
  /** null when it could not be determined */
  clean: boolean | null;
  /** Commits in HEAD that the installed build lacks (max 20). */
  pendingCommits: string[];
  /** Commits in the installed build that HEAD lacks (max 20). */
  installedOnlyCommits: string[];
  /** Why that list could not be read; informational, does not block Build. */
  installedOnlyError: string | null;
  /** Why installed-vs-HEAD could not be compared (an sha the clone lacks). */
  installedRelationError: string | null;
  installedRelation: InstalledRelation;
  /** A git operation the clone is in the middle of ("rebase", "merge", …). */
  gitOperation: string | null;
  /** Why pendingCommits could not be listed; informational, does not block Build. */
  pendingCommitsError: string | null;
  /** e.g. "origin/main"; null when the branch has no tracking ref. */
  upstream: string | null;
  /** Commits on the tracking ref that HEAD lacks; null when unreadable. */
  newOnRemote: number | null;
  /** Local commits the tracking ref does not have. */
  unpushed: number | null;
  newOnRemoteCommits: string[];
  unpushedCommits: string[];
  remoteError: string | null;
  /** Why Pull is refused, in words; null means it is a waiting fast-forward. */
  pullError: string | null;
  /** When the main process last fetched the tracking ref (0 h for never). */
  lastFetchMs: number | null;
  /** Why that fetch failed; null when it did not run or worked. */
  fetchError: string | null;
  /** install.log lines of the most recent install attempt (empty if none). */
  lastInstall: string[];
  build: {
    running: boolean;
    log: string[];
    result: SelfUpdateBuildResult | null;
  };
}

export interface SelfUpdateArchiveEntry {
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
  version?: string;
  sha?: string;
  /** Branch it was built from (archive index); null for older installers. */
  branch?: string | null;
}

/** Phases of the in-app upstream sync — see electron/upstream-sync.mjs. */
export type SyncPhase =
  | "unavailable"
  | "wrongBranch"
  | "upToDate"
  | "available"
  | "conflict"
  | "rebased"
  | "dirty"
  | "installed";

/** The only agent choices the renderer may ask the main process to start. */
export type SyncAgentKind = "opencode" | "claude";

export interface SyncSettings {
  syncBranch: string;
  upstreamRemote: string;
  forkRemote: string;
  opencodeModel: string;
}

/** The sync record in `<userData>/upstream-sync.json`; null when none. */
export interface SyncRecord {
  latestTag: string;
  backupBranch: string;
  originSha: string | null;
  startedMs: number;
  pushed: boolean;
  fetchError?: string | null;
}

export interface SyncAgentInfo {
  kind: SyncAgentKind;
  label: string;
  /** null when the wrapper died before reporting a PID (the record is kept). */
  pid: number | null;
  running: boolean;
  logPath: string;
  log: string[];
  errLog: string[];
}

/** What `syncState`/`syncCheck` return: live git facts plus the phase. */
export interface SyncPayload {
  ok: boolean;
  error?: string;
  supported: boolean;
  packaged: boolean;
  gitFound: boolean;
  agents: Record<SyncAgentKind, boolean>;
  settings: SyncSettings;
  state: SyncRecord | null;
  phase: SyncPhase;
  installedUpstreamTag: string | null;
  installedSha: string | null;
  buildTime: string | null;
  lastCheckError: string | null;
  lastFetchMs: number | null;
  /** Display only: the push that ended the most recent finished sync. */
  lastSync: {
    tag: string;
    pushedMs: number;
    backupBranch: string | null;
    /** The branch the push rewound; the row is hidden for any other branch. */
    branch?: string | null;
  } | null;
  /**
   * Display only: what the key-level merge of `src/i18n/translation.json` did during this sync —
   * the one conflict every sync of this fork has. Null when the resolver never ran.
   */
  autoMerge: {
    /** How many rebase stops it cleared. */
    stops: number;
    /** Fork keys it took (added plus updated). */
    keys: number;
    /** Keys both sides changed differently, so it left the file for a human. */
    conflicts: string[];
    /** Why it stopped (null when it did all it could). */
    error: string | null;
    ms: number;
  } | null;
  /** Why the build the last clean rebase started never ran; null when fine. */
  autoBuildError: string | null;
  /** True on the payload that dropped a stale record (rebase resolved outside). */
  syncRecordCleared: boolean;
  /** The backup branch of that cleared record — the user's only way back. */
  clearedBackup: string | null;
  /** What Discard would drop, for the two-step confirmation. */
  discardPreview: {
    backupBranch: string;
    /** Where the rolled-back commits are kept (null: an older sync record). */
    discardedBranch: string | null;
    commits: string[];
    truncated: boolean;
  } | null;
  /** Only set on the `syncCheck` reply: why the upstream fetch failed, if it did. */
  checkError?: string | null;
  building: boolean;
  agent: SyncAgentInfo | null;
  repoPath: string | null;
  branch: string | null;
  headSha: string | null;
  onSyncBranch: boolean;
  clean: boolean | null;
  latestTag: string | null;
  cloneBaseTag: string | null;
  forkCommitCount: number | null;
  rebaseInProgress: boolean;
  conflictedFiles: string[];
  updateAvailable: boolean;
  branchContainsTarget: boolean;
  /** Markdown brief for a conflict agent or for pasting into a terminal. */
  taskText: string;
}

export interface SelfUpdateBridge {
  status: () => Promise<SelfUpdateStatus>;
  /** Live upstream-sync snapshot; never starts a fetch or a mutation. */
  syncState: () => Promise<SyncPayload>;
  /** `force` re-runs `git fetch`; otherwise a fetch younger than 6h is kept. */
  syncCheck: (force?: boolean) => Promise<SyncPayload>;
  syncStart: () => Promise<{
    ok: boolean;
    error?: string;
    phase?: SyncPhase;
    targetTag?: string;
    backupBranch?: string;
    /** False when the rebase stopped on conflicts: no build was started. */
    buildStarted?: boolean;
  }>;
  syncAgent: (kind: SyncAgentKind) => Promise<{
    ok: boolean;
    error?: string;
    pid?: number;
    logPath?: string;
    taskPath?: string;
  }>;
  syncAbort: () => Promise<{ ok: boolean; error?: string }>;
  syncDiscard: () => Promise<{
    ok: boolean;
    error?: string;
    backupBranch?: string;
    /** The branch the discarded commits were kept on. */
    discardedBranch?: string;
  }>;
  syncPush: () => Promise<{
    ok: boolean;
    error?: string;
    pushedTo?: string;
    tag?: string;
  }>;
  build: () => Promise<SelfUpdateBuildResult>;
  cancel: () => Promise<{ ok: boolean; error?: string }>;
  install: (installerPath: string) => Promise<{ ok: boolean; error?: string }>;
  /** `git fetch` of the current branch's tracking ref only (main process owns it). */
  fetch: () => Promise<{ ok: boolean; error?: string }>;
  /** `git merge --ff-only @{upstream}`; refused unless it is a fast-forward. */
  pull: () => Promise<{ ok: boolean; error?: string; output?: string }>;
  listArchive: () => Promise<{
    ok: boolean;
    archive?: SelfUpdateArchiveEntry[];
    error?: string;
  }>;
  onLog: (cb: (lines: string[]) => void) => () => void;
}

declare global {
  interface Window {
    agentCanvasSelfUpdate?: SelfUpdateBridge;
  }
}

export function getSelfUpdateBridge(): SelfUpdateBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : window.agentCanvasSelfUpdate;
}
