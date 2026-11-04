/**
 * Pure rules for the in-app upstream sync (see ../upstream-sync.mjs).
 *
 * No Electron, no filesystem, no child processes: every rule that decides what
 * git may be asked to do — which tag counts as a release, which backup branch
 * name is ours, which push line may be run, which phase the clone is in — lives
 * here so it can be unit-tested.
 */

/** What `<userData>/self-update.json` may override; these are the defaults. */
export const DEFAULT_SYNC_SETTINGS = {
  syncBranch: "main",
  upstreamRemote: "upstream",
  forkRemote: "origin",
  opencodeModel: "ax_h200/selfhosted-model#xhigh",
};

const SETTINGS_REF_KEYS = ["syncBranch", "upstreamRemote", "forkRemote"];

/**
 * A branch or remote name we are willing to put into a git argument vector.
 * Restrictive on purpose: the renderer never sends these (they come from the
 * settings file), so anything unusual is a typo or an attack, not a real name.
 * It also rejects what git itself refuses (`..`, `//`, refcontrol chars,
 * `.lock`, leading/trailing punctuation).
 */
export function isSafeRefName(name) {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 100) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) {
    return false;
  }
  if (/^[-./]/.test(name) || /[-./]$/.test(name)) return false;
  return !name.endsWith(".lock");
}

/** The settings file's sync entries, each validated; bad values fall back. */
export function resolveSyncSettings(override) {
  const settings = { ...DEFAULT_SYNC_SETTINGS };
  for (const key of SETTINGS_REF_KEYS) {
    const value = override?.[key];
    if (typeof value === "string" && isSafeRefName(value.trim())) {
      settings[key] = value.trim();
    }
  }
  const model = override?.opencodeModel;
  if (typeof model === "string" && MODEL_RE.test(model.trim())) {
    settings.opencodeModel = model.trim();
  }
  return settings;
}

// ── release tags ──────────────────────────────────────────────────────────────

/** A release tag is exactly `v<major>.<minor>.<patch>`; `v1.23.0-r2` is not. */
export const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

export function isReleaseTag(tag) {
  return RELEASE_TAG_RE.test(String(tag ?? "").trim());
}

/** `[major, minor, patch]` for a release tag, null for anything else. */
export function parseReleaseTag(tag) {
  const m = RELEASE_TAG_RE.exec(String(tag ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric semver order; non-release tags never outrank release tags. */
export function compareReleaseTags(a, b) {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Highest release tag in a `git tag --list` dump.
 * @returns {string|null}
 */
export function newestReleaseTag(tags) {
  const candidates = [...new Set(tags ?? [])].filter(isReleaseTag);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, tag) =>
    compareReleaseTags(tag, best) > 0 ? tag : best,
  );
}

// ── backup branches ───────────────────────────────────────────────────────────

/** `backup/<branch>-<yyyymmdd-HHMMss>` in local time (the stamp is ours). */
export function backupBranchName(branch, date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  const stamp =
    `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `backup/${branch}-${stamp}`;
}

/** Whether a name is one this app generated (so `discard` may reset to it). */
export function isBackupBranchName(name) {
  return (
    typeof name === "string" &&
    /^backup\/[A-Za-z0-9._/-]{1,80}-\d{8}-\d{6}$/.test(name) &&
    isSafeRefName(name)
  );
}

// ── conflict agent ────────────────────────────────────────────────────────────

/** The two CLIs we know how to drive; only these may come from the renderer. */
export const AGENT_KINDS = ["opencode", "claude"];

export const AGENT_LABELS = { opencode: "opencode", claude: "Claude Code" };

/** Model ids we accept for `opencode -m` (no quoting or flag tricks). */
export const MODEL_RE = /^[A-Za-z0-9._/#:@-]{1,120}$/;

/**
 * The prompt: one line that points at the task file, so nothing long ever ends
 * up on a command line (PowerShell quoting of a multi-paragraph prompt is not a
 * risk worth taking).
 */
export function agentPrompt(taskFile) {
  return `Read the file ${String(taskFile).trim()} and follow it exactly.`;
}

/**
 * The argv for a conflict agent, started in the clone.
 *
 * @param {{kind: string, model?: string, taskFile: string}} input
 * @returns {{exe: string, args: string[]}|null} null when anything is off
 */
export function agentCommandLine({ kind, model, taskFile }) {
  if (!AGENT_KINDS.includes(kind)) return null;
  const file = typeof taskFile === "string" ? taskFile.trim() : "";
  if (file === "" || /[\r\n\0]/.test(file)) return null;
  const prompt = agentPrompt(file);
  if (kind === "opencode") {
    const id = typeof model === "string" ? model.trim() : "";
    if (!MODEL_RE.test(id)) return null;
    return {
      exe: "opencode",
      args: [
        "run",
        "--auto",
        "-m",
        id,
        "--title",
        "agent-canvas-rebase",
        prompt,
      ],
    };
  }
  return {
    exe: "claude",
    args: [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(git *)",
      "Bash(npm *)",
      "Bash(npx *)",
    ],
  };
}

/**
 * Everything the fork adds to this repo (from CUSTOM_FORK.md). An agent
 * resolving conflicts needs to know which files exist because of us.
 */
export const FORK_FILES = [
  "electron/main.mjs",
  "electron/preload-main.cjs",
  "electron/self-update.mjs",
  "electron/upstream-sync.mjs",
  "electron/lib/self-update-logic.mjs",
  "electron/lib/self-update-logic.test.mjs",
  "electron/lib/upstream-sync-logic.mjs",
  "electron/lib/upstream-sync-logic.test.mjs",
  "electron/lib/install-helper-script.mjs",
  "electron/lib/agent-launch-script.mjs",
  "scripts/write-build-info.mjs",
  "package.json",
  ".gitignore",
  "src/utils/self-update-bridge.ts",
  "src/routes/app-settings.tsx",
  "src/components/features/settings/custom-build-card.tsx",
  "src/components/features/settings/custom-build-card.test.tsx",
  "src/components/features/settings/upstream-sync-panel.tsx",
  "src/components/features/settings/upstream-sync-panel.test.tsx",
  "src/components/features/settings/upstream-sync-sidebar-card.tsx",
  "src/components/features/settings/upstream-sync-sidebar-card.test.tsx",
  "src/components/features/settings/agent-canvas-update-card.tsx",
  "src/i18n/translation.json",
];

/**
 * The task an agent (or the user, from the clipboard) works through. Generated
 * here so the text is unit-tested and identical for both paths.
 */
export function syncTaskText({
  repoPath,
  branch,
  targetTag,
  backupBranch,
  conflictedFiles = [],
}) {
  const files = conflictedFiles.length
    ? conflictedFiles.map((f) => `- ${f}`).join("\n")
    : "- (none listed — run `git status` to see what git reports)";
  return `# Finish the Agent Canvas fork rebase

Repo: ${repoPath}  (start by cd-ing into it; do not work anywhere else)
Branch: ${branch}  (the app started \`git rebase ${targetTag}\` here and it stopped on conflicts)
Target tag: ${targetTag}
Backup branch: ${backupBranch}  (the branch exactly as it was before the sync — keep it, do not delete or move it)

Conflicted files right now:
${files}

These files exist because of the fork, so they are where upstream changes collide with it:
${FORK_FILES.map((f) => `- ${f}`).join("\n")}

## Rules

1. Keep the fork's behaviour. Re-apply the fork's changes on top of upstream's,
   adapted to upstream's new code — do not drop either side, and do not resolve
   a conflict by taking one whole file.
2. For each conflict: edit the file until it is right, \`git add\` it, then run
   \`GIT_EDITOR=true git rebase --continue\` (on Windows PowerShell use
   \`$env:GIT_EDITOR='true'\` first). Repeat until the rebase reports done.
   Never \`--skip\` a fork commit to make a conflict go away.
3. When the rebase is complete, run these and fix what they report:
   - \`npm run typecheck\`
   - \`npx vitest run electron/lib src/components/features/settings\`
   - \`npm run check-translation-completeness\`
4. Commit any follow-up fixes as new commits on this branch (one-line
   conventional messages, e.g. \`fix(desktop): adapt self-update to upstream X\`).
5. Never push. Never \`git reset\` and never \`git rebase --abort\` — unless the
   conflicts genuinely cannot be resolved, in which case abort and write a short
   explanation of why at the end of this log.
6. Do not install anything globally, do not touch other branches or repos, and
   leave \`CUSTOM_FORK.md\` readable (append what changed if you had to adapt).
`;
}

// ── fetch ─────────────────────────────────────────────────────────────────────

/**
 * One readable line for a failed `git fetch`. git writes the interesting part to
 * stderr; a tag it refuses to move appears as
 * `! [rejected] v1.34.0 -> v1.34.0 (would clobber existing tag)`, so those lines
 * are quoted first — they name the local tag the user has to deal with.
 *
 * @param {string|null|undefined} error the stderr of the failed fetch
 * @returns {string}
 */
export function describeFetchFailure(error) {
  const text = String(error ?? "").trim();
  if (text === "") return "the fetch failed";
  const rejected = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("! [rejected]"));
  if (rejected.length === 0) return text;
  const names = [
    ...new Set(
      rejected.map((line) => (line.split(/\s+/)[2] ?? "").split("->")[0]),
    ),
  ].filter(Boolean);
  return `${rejected.join("; ")} — delete or rename ${names.join(", ") || "that local tag"} and press Check again`;
}

// ── push ──────────────────────────────────────────────────────────────────────

/**
 * argv for the one push the app is allowed to run: the sync branch to the fork,
 * guarded by a lease on the remote sha recorded before the sync started.
 *
 * @param {{forkRemote: string, branch: string, expectedRemoteSha?: string|null}} input
 * @returns {string[]|null}
 */
export function pushArgs({ forkRemote, branch, expectedRemoteSha }) {
  if (!isSafeRefName(forkRemote) || !isSafeRefName(branch)) return null;
  const sha =
    typeof expectedRemoteSha === "string"
      ? expectedRemoteSha.trim().toLowerCase()
      : "";
  if (sha !== "" && !/^[0-9a-f]{40}$/.test(sha)) return null;
  // No sha means the branch was never pushed: the lease then guards against
  // anyone else having pushed since we fetched, which is the same protection.
  const lease = sha
    ? `--force-with-lease=${branch}:${sha}`
    : `--force-with-lease=${branch}`;
  return ["push", lease, forkRemote, branch];
}

// ── rebase state ──────────────────────────────────────────────────────────────

/**
 * The branch a paused rebase was working on, read from git's `head-name` file
 * (`refs/heads/<branch>`). While a rebase is stopped, `HEAD` is detached, so this
 * file is the only place the branch still appears. null for anything else, so the
 * caller never has to guess.
 */
export function branchFromHeadName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name.startsWith("refs/heads/")) return null;
  return name.slice("refs/heads/".length) || null;
}

// ── phases ────────────────────────────────────────────────────────────────────

/**
 * Which phase the sync is in, from the persisted state and what git says.
 *
 * @param {object} input
 * @param {{latestTag: string, backupBranch: string, originSha: string|null,
 *   pushed?: boolean}|null} input.state the app's sync state file (null = none)
 * @param {object} input.repo live repo facts: gitFound, repoPath, onSyncBranch,
 *   rebaseInProgress, clean, branchContainsTarget, installedSha, headSha,
 *   updateAvailable
 */
export function deriveSyncPhase({ state, repo }) {
  if (!repo?.gitFound || !repo?.repoPath) return "unavailable";
  if (!repo.onSyncBranch) return "wrongBranch";
  // A rebase in progress is the only fact that matters: nothing else is stable.
  if (repo.rebaseInProgress) return "conflict";
  const target = state?.latestTag ?? null;
  if (!target || !repo.branchContainsTarget) {
    // Nothing to finish: either no sync was started, or it was resolved (or
    // rolled back) outside the app.
    return repo.updateAvailable ? "available" : "upToDate";
  }
  // No `pushed` phase: a push clears the record, and the payload's `lastSync`
  // row is what reports it afterwards.
  // The point of the feature: the app is running the rebased clone.
  if (repo.installedSha && repo.installedSha === repo.headSha)
    return "installed";
  if (!repo.clean) return "dirty";
  return "rebased";
}
