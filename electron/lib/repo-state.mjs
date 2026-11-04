/**
 * git's own operation state, read from its marker files (see ../self-update.mjs
 * and ../upstream-sync.mjs).
 *
 * Nothing a command line can be talked into: while git is mid-rebase, `HEAD` is
 * detached and `git status` says little, so the only reliable answer is the state
 * directory git maintains. This is the same probe the upstream sync used (its
 * `rebaseState`), widened to the other operations a Pull must not run over —
 * a merge or a cherry-pick that was left conflicted — and moved here because both
 * features and the card need one answer, not two.
 */

import { join } from "node:path";

import { branchFromHeadName } from "./upstream-sync-logic.mjs";

/**
 * Which sequencer git has paused, and the branch it was working on.
 *
 * Rebase first: a conflicted rebase step also leaves a `CHERRY_PICK_HEAD`, so
 * checking the cherry-pick marker first would report the wrong operation (and the
 * wrong command to recover with).
 *
 * @param {{repo: string, env?: object,
 *   run: (cmd: string, args: string[], cwd: string, env?: object) =>
 *     Promise<{ok: boolean, stdout: string, error?: string}>,
 *   existsSync: (path: string) => boolean,
 *   readText: (path: string) => string}} deps injected so the rule is unit-testable
 *   (the same style as isTrustedSender, which takes the URL predicate)
 * @returns {Promise<{operation: "rebase"|"merge"|"cherry-pick"|"revert"|null,
 *   branch: string|null, gitDir: string|null}>} null operation and gitDir when git
 *   could not answer, so the caller never mistakes "unknown" for "clean".
 */
export async function repoOperation({ repo, env, run, existsSync, readText }) {
  const none = { operation: null, branch: null, gitDir: null };
  const dir = await run("git", ["rev-parse", "--absolute-git-dir"], repo, env);
  const gitDir = dir.ok ? dir.stdout.trim() : "";
  if (gitDir === "") return none;

  const exists = (key) => existsSync(join(gitDir, key));
  if (exists("rebase-merge") || exists("rebase-apply")) {
    return {
      operation: "rebase",
      // Only a merge rebase carries head-name; `git am` does not.
      branch: branchFromHeadName(
        readText(join(gitDir, "rebase-merge", "head-name")),
      ),
      gitDir,
    };
  }
  if (exists("MERGE_HEAD")) return { operation: "merge", branch: null, gitDir };
  if (exists("CHERRY_PICK_HEAD"))
    return { operation: "cherry-pick", branch: null, gitDir };
  if (exists("REVERT_HEAD"))
    return { operation: "revert", branch: null, gitDir };
  return { operation: null, branch: null, gitDir };
}
