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
  pendingCommits: string[];
  /** Why pendingCommits could not be listed; informational, does not block Build. */
  pendingCommitsError: string | null;
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
