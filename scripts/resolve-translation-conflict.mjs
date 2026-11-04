/**
 * Resolve a conflicted `src/i18n/translation.json` at key level.
 *
 * Why this exists: the fork adds its i18n keys at the end of the file and upstream does the same,
 * so every upstream sync stops on this one file even when the two sides touch completely different
 * keys. git merges lines, this merges keys. It is the same function the app's sync uses
 * (`electron/upstream-sync.mjs`), so a human, an agent and the app always agree on the answer.
 *
 * Usage (from anywhere inside the clone):
 *
 *   node scripts/resolve-translation-conflict.mjs
 *
 * Exit codes: `0` the file was merged and staged; `1` there is a real conflict (the keys are
 * printed) or the merge cannot be trusted, so nothing was written; `2` not applicable (the file is
 * not conflicted right now, or this is not a git repo).
 *
 * It only ever writes that one file, and only after the merge says it is unambiguous. The keys it
 * refuses to guess at are left in the file with git's own markers, untouched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRANSLATION_FILE,
  mergeTranslations,
} from "../electron/lib/translation-merge.mjs";
import { continueCommandFor } from "../electron/lib/upstream-sync-logic.mjs";

/**
 * Which sequencer git has paused, read from its own marker files. A conflicted
 * rebase step also leaves a CHERRY_PICK_HEAD (inside the rebase directory), so the
 * rebase directories are checked first. null = neither, so nothing is claimed.
 */
function pausedOperation(repoDir) {
  const dir = git(repoDir, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return null;
  const gitDir = dir.stdout.trim();
  if (gitDir === "") return null;
  if (existsSync(join(gitDir, "rebase-merge"))) return "rebase";
  if (existsSync(join(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  return null;
}

/** Run git with an argument array (never a shell string) and report failure instead of throwing. */
function git(repoDir, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err.stderr || err.message)
        .trim()
        .split(/\r?\n/)[0],
    };
  }
}

/**
 * One merge stage of the file (`git show :<stage>:<path>`). A stage that does not exist is a real
 * answer — in an add/add conflict there is no stage 1 — so `null` means "this side has no version".
 */
function stage(repoDir, number) {
  const got = git(repoDir, ["show", `:${number}:${TRANSLATION_FILE}`]);
  return got.ok ? { text: got.stdout } : { error: got.error };
}

function main() {
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(
      "Usage: node scripts/resolve-translation-conflict.mjs\n" +
        "Key-level merge for a conflicted " +
        `${TRANSLATION_FILE} during a rebase.\n` +
        "Exit 0 = merged and staged, 1 = real conflicts, 2 = not applicable.\n",
    );
    return 0;
  }

  const top = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    process.stdout.write(`not a git repository: ${top.error}\n`);
    return 2;
  }
  const repoDir = top.stdout.trim();

  const unmerged = git(repoDir, ["diff", "--name-only", "--diff-filter=U"]);
  if (!unmerged.ok) {
    process.stdout.write(`git could not read the index: ${unmerged.error}\n`);
    return 2;
  }
  const conflicted = unmerged.stdout
    .split(/\r?\n/)
    .filter((line) => line !== "");
  if (!conflicted.includes(TRANSLATION_FILE)) {
    process.stdout.write(
      `nothing to do: ${TRANSLATION_FILE} is not conflicted` +
        (conflicted.length ? ` (these are: ${conflicted.join(", ")})\n` : "\n"),
    );
    return 2;
  }

  const base = stage(repoDir, 1);
  const ours = stage(repoDir, 2);
  const theirs = stage(repoDir, 3);
  // Ours (what is being rebased onto) or theirs (the fork commit being replayed) missing means one
  // side deleted the whole file. That is a human decision, not a key merge.
  if (ours.error || theirs.error) {
    process.stdout.write(
      `cannot merge: one side has no version of the file\n` +
        `  ours:   ${ours.error ?? "readable"}\n` +
        `  theirs: ${theirs.error ?? "readable"}\n`,
    );
    return 1;
  }

  const merged = mergeTranslations(base.text ?? null, ours.text, theirs.text);

  if (!merged.ok && merged.conflicts.length > 0) {
    process.stdout.write(
      `${TRANSLATION_FILE} has real key conflicts (${merged.conflicts.length}):\n` +
        merged.conflicts.map((key) => `  - ${key}\n`).join("") +
        "Both sides changed those keys differently. Fix them in the file, then `git add` it.\n" +
        "The file was left as git wrote it.\n",
    );
    return 1;
  }
  if (!merged.ok) {
    process.stdout.write(
      `cannot merge safely: ${merged.error}\nThe file was left as git wrote it.\n`,
    );
    return 1;
  }

  writeFileSync(join(repoDir, TRANSLATION_FILE), merged.text, "utf8");
  const added = git(repoDir, ["add", "--", TRANSLATION_FILE]);
  if (!added.ok) {
    process.stdout.write(
      `merged the file but \`git add\` failed: ${added.error}\n` +
        "Run `git add -- " +
        TRANSLATION_FILE +
        "` yourself.\n",
    );
    return 1;
  }

  const parts = [
    `${merged.added.length} added`,
    `${merged.changed.length} updated`,
    `${merged.removed.length} removed`,
  ];
  // Which command resumes depends on what git was doing when it stopped: a paused
  // cherry-pick does not answer to `git rebase --continue`.
  const goOn = continueCommandFor(pausedOperation(repoDir));
  process.stdout.write(
    `merged ${TRANSLATION_FILE} at key level (${parts.join(", ")}) and staged it.\n` +
      (conflicted.length === 1
        ? goOn
          ? `That was the only conflict: run \`${goOn}\`.\n`
          : "That was the only conflict: now continue the operation you were running.\n"
        : `${conflicted.length - 1} other file(s) still conflicted: ${conflicted
            .filter((f) => f !== TRANSLATION_FILE)
            .join(", ")}\n`),
  );
  return 0;
}

// Resolved repo root of this script's own repo, so the import path above is the one that is used.
void fileURLToPath(import.meta.url);

process.exitCode = main();
