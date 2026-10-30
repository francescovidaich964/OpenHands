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

export interface SelfUpdateBridge {
  status: () => Promise<SelfUpdateStatus>;
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
