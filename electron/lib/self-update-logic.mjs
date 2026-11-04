/**
 * Pure helpers for the "Rebuild & Install" feature (see ../self-update.mjs).
 *
 * Kept free of Electron and of any filesystem/process access so the rules that
 * matter for safety — which installer paths may be executed, which build
 * output counts as fresh, which archives get pruned — are unit-testable.
 */

import { win32 } from "node:path";

const { basename, dirname, resolve, sep } = win32;

/** Max lines of build output kept in memory / replayed to the renderer. */
export const BUILD_LOG_MAX_LINES = 2000;

const ARCHIVE_NAME_RE = /^Agent-Canvas-Setup-(.+)-([0-9a-f]{7,40})\.exe$/i;

/** `Agent-Canvas-Setup-<version>-<shortsha>.exe` */
export function archiveFileName(version, sha) {
  return `Agent-Canvas-Setup-${version}-${sha}.exe`;
}

/** Parse an archive file name; null when it is not one of ours. */
export function parseArchiveFileName(name) {
  const m = ARCHIVE_NAME_RE.exec(name);
  return m ? { version: m[1], sha: m[2] } : null;
}

/**
 * Whether `installerPath` is an acceptable thing to execute (Windows paths;
 * the installer helper is Windows-only): a file named like one of our archived
 * installers that is a DIRECT child of the archive directory. No traversal, no
 * nested dirs, no other drives, no stray `.exe` someone dropped in there. The
 * comparison is case-insensitive on Windows paths.
 */
export function isArchivedInstallerPath(installerPath, archiveDir) {
  if (typeof installerPath !== "string" || typeof archiveDir !== "string") {
    return false;
  }
  if (installerPath.includes("\0") || installerPath.trim() === "") return false;
  const resolved = resolve(installerPath);
  const root = resolve(archiveDir);
  return (
    parseArchiveFileName(basename(resolved)) !== null &&
    dirname(resolved).toLowerCase() === root.toLowerCase() &&
    resolved.toLowerCase().startsWith(root.toLowerCase() + sep)
  );
}

/**
 * The lines of the most recent helper run in install.log (from its last
 * "helper started" line), at most `max` lines; [] when there is none.
 */
export function lastInstallRun(logText, max = 40) {
  const lines = String(logText ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes("helper started")) {
      start = i;
      break;
    }
  }
  return start < 0 ? [] : lines.slice(start).slice(-max);
}

/**
 * Pick the installer a build just produced from the output directory listing.
 *
 * @param {{name: string, mtimeMs: number}[]} entries files in dist-electron
 * @param {number} buildStartedMs Date.now() taken before the build began
 * @returns the newest `*Setup*.exe` written at or after the build started, or
 *   null (a stale installer from an earlier build must not be mistaken for
 *   this build's output).
 */
export function findNewestInstaller(entries, buildStartedMs) {
  const candidates = entries.filter(
    (e) =>
      /setup/i.test(e.name) &&
      /\.exe$/i.test(e.name) &&
      !/__uninstaller/i.test(e.name) &&
      e.mtimeMs >= buildStartedMs,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
}

/**
 * Archive entries to delete after a build. The archive is a rollback anchor,
 * not a history: it keeps the installer just built (Restart to install needs
 * it), the newest installer built from `anchorBranch` (the fork's main), and
 * the `anchorKeep` newest of those while an upstream sync is unfinished (so
 * the pre-sync build survives until the sync is pushed or discarded).
 * Only files that look like our archive names are ever considered; an entry
 * with no index record (built before the index existed) counts as not-anchor.
 *
 * @param {{name: string, mtimeMs: number}[]} entries
 * @param {{keepName?: string, index?: Record<string, {branch?: string}>,
 *   anchorBranch?: string, anchorKeep?: number}} opts
 */
export function selectArchiveToPrune(
  entries,
  { keepName, index = {}, anchorBranch = "main", anchorKeep = 1 } = {},
) {
  const ours = sortArchive(entries);
  const keep = new Set(keepName ? [keepName] : []);
  ours
    .filter((e) => index[e.name]?.branch === anchorBranch)
    .slice(0, Math.max(1, anchorKeep))
    .forEach((e) => keep.add(e.name));
  return ours.filter((e) => !keep.has(e.name)).map((e) => e.name);
}

/** Newest first, restricted to our archive names. */
export function sortArchive(entries) {
  return entries
    .filter((e) => parseArchiveFileName(e.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Keep only the last `max` lines. Mutates and returns `lines`. */
export function trimLog(lines, max = BUILD_LOG_MAX_LINES) {
  if (lines.length > max) lines.splice(0, lines.length - max);
  return lines;
}

/**
 * Split a raw output chunk into lines, carrying a trailing partial line over
 * to the next chunk. Strips ANSI escapes and reduces `\r` progress redraws to
 * their final frame.
 *
 * @returns {{lines: string[], rest: string}}
 */
export function splitChunk(rest, chunk) {
  const text = rest + chunk;
  const parts = text.split(/\r?\n/);
  const newRest = parts.pop() ?? "";
  const clean = (s) =>
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .split("\r")
      .pop();
  return { lines: parts.map(clean), rest: newRest };
}

/** Lines of `git log --oneline`, trimmed, empty lines dropped. */
export function parseLogLines(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Which repo the app should treat as its clone: the userData override file's
 * `repoPath` wins over the path baked in at build time.
 */
export function resolveRepoPath(buildInfo, override) {
  const o = override?.repoPath;
  if (typeof o === "string" && o.trim() !== "") return o.trim();
  const b = buildInfo?.repoPath;
  return typeof b === "string" && b.trim() !== "" ? b : null;
}

/**
 * Whether IPC from `senderUrl` may drive self-update: only the app's own
 * loopback page, in the main frame of the app's own main window.
 */
export function isTrustedSender({
  senderIsMainWindow,
  senderIsMainFrame,
  senderUrl,
  isLoopbackAppUrl,
}) {
  return Boolean(
    senderIsMainWindow &&
    senderIsMainFrame &&
    typeof senderUrl === "string" &&
    isLoopbackAppUrl(senderUrl),
  );
}
