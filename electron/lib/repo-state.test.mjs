import { describe, expect, it, vi } from "vitest";

import { repoOperation } from "./repo-state.mjs";

/**
 * git answers `rev-parse --absolute-git-dir` with a real path; here it is a fake
 * one and the existence checks are injected, so the rule (which state file means
 * which operation) is what this tests — the paths themselves are proven against a
 * real repo in the Phase 5 evidence.
 */
const GIT_DIR = "/repo/.git";

function makeDeps({ files = [], headName = "", gitDirOk = true } = {}) {
  // A real fs reports a directory as existing when it holds the file, so every
  // ancestor of a registered file exists too.
  const set = new Set(
    files.flatMap((f) =>
      f
        .split("/")
        .map((_, i, all) => `${GIT_DIR}/${all.slice(0, i + 1).join("/")}`),
    ),
  );
  return {
    repo: "/repo",
    env: { GIT_TERMINAL_PROMPT: "0" },
    existsSync: vi.fn((p) => set.has(String(p).replace(/\\/g, "/"))),
    readText: vi.fn((p) => (String(p).endsWith("head-name") ? headName : "")),
    run: vi.fn(async () =>
      gitDirOk
        ? { ok: true, stdout: `${GIT_DIR}\n` }
        : { ok: false, error: "no" },
    ),
  };
}

describe("repoOperation", () => {
  it("reads git's own git dir once and reports nothing when no state file exists", async () => {
    const d = makeDeps();
    expect(await repoOperation(d)).toEqual({
      operation: null,
      branch: null,
      gitDir: GIT_DIR,
    });
    expect(d.run).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--absolute-git-dir"],
      "/repo",
      d.env,
    );
  });

  it("reports a paused rebase and the branch from git's own head-name file", async () => {
    const d = makeDeps({
      files: ["rebase-merge/head-name", "CHERRY_PICK_HEAD"],
      headName: "refs/heads/main\n",
    });
    expect(await repoOperation(d)).toEqual({
      operation: "rebase",
      branch: "main",
      gitDir: GIT_DIR,
    });
  });

  it("tells `git am` (rebase-apply) from a merge rebase", async () => {
    const d = makeDeps({ files: ["rebase-apply/current-patch"] });
    expect((await repoOperation(d)).operation).toBe("rebase");
  });

  it.each([
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ])("%s means %s", async (file, operation) => {
    const d = makeDeps({ files: [file] });
    expect(await repoOperation(d)).toEqual({
      operation,
      branch: null,
      gitDir: GIT_DIR,
    });
  });

  it("is null when git cannot answer (not a repo)", async () => {
    const d = makeDeps({ gitDirOk: false });
    expect(await repoOperation(d)).toEqual({
      operation: null,
      branch: null,
      gitDir: null,
    });
    expect(d.existsSync).not.toHaveBeenCalled();
  });

  it("is null when git prints no directory", async () => {
    const d = makeDeps();
    d.run = vi.fn(async () => ({ ok: true, stdout: "\n" }));
    expect(await repoOperation(d)).toEqual({
      operation: null,
      branch: null,
      gitDir: null,
    });
  });
});
