import { describe, expect, it } from "vitest";

import {
  AGENT_KINDS,
  DEFAULT_SYNC_SETTINGS,
  FORK_FILES,
  agentCommandLine,
  agentPrompt,
  backupBranchName,
  branchFromHeadName,
  compareReleaseTags,
  deriveSyncPhase,
  describeFetchFailure,
  isBackupBranchName,
  isReleaseTag,
  isSafeRefName,
  newestReleaseTag,
  parseReleaseTag,
  pushArgs,
  resolveSyncSettings,
  syncTaskText,
} from "./upstream-sync-logic.mjs";

describe("isSafeRefName", () => {
  it.each([
    "main",
    "custom/upstream-sync",
    "upstream",
    "origin",
    "v1.2_x",
    "a.b",
  ])("accepts %s", (name) => expect(isSafeRefName(name)).toBe(true));

  it.each([
    "main; rm -rf",
    "main -u",
    "a\nb",
    "a&&b",
    "a|b",
    "a`b",
    "a$b",
    "a'b",
    'a"b',
    "a\\b",
    "../evil",
    "a..b",
    "a//b",
    "a@{1}",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b]",
    "-lead",
    ".lead",
    "/lead",
    "trail/",
    "trail-",
    "trail.",
    "x.lock",
    "",
    "x".repeat(101),
  ])("rejects %j", (name) => expect(isSafeRefName(name)).toBe(false));

  it.each([undefined, null, 42, {}, []])("rejects %j", (name) =>
    expect(isSafeRefName(name)).toBe(false),
  );
});

describe("resolveSyncSettings", () => {
  it("defaults everything when there is no settings file", () => {
    expect(resolveSyncSettings(null)).toEqual(DEFAULT_SYNC_SETTINGS);
    expect(DEFAULT_SYNC_SETTINGS.syncBranch).toBe("main");
    expect(DEFAULT_SYNC_SETTINGS.upstreamRemote).toBe("upstream");
    expect(DEFAULT_SYNC_SETTINGS.forkRemote).toBe("origin");
  });

  it("takes the settings that are valid and trims them", () => {
    expect(
      resolveSyncSettings({
        syncBranch: "  custom/self-update  ",
        forkRemote: "fork",
      }),
    ).toEqual({
      ...DEFAULT_SYNC_SETTINGS,
      syncBranch: "custom/self-update",
      forkRemote: "fork",
    });
  });

  it("keeps a valid opencodeModel", () => {
    expect(
      resolveSyncSettings({ opencodeModel: "ax_h200/selfhosted-model#xhigh" }),
    ).toMatchObject({ opencodeModel: "ax_h200/selfhosted-model#xhigh" });
  });

  it.each([
    { syncBranch: "main; rm -rf" },
    { upstreamRemote: "" },
    { forkRemote: " " },
    { opencodeModel: "evil -m x ; calc" },
    { syncBranch: 42 },
    { opencodeModel: "x".repeat(200) },
  ])("falls back on a bad entry %j", (override) => {
    const out = resolveSyncSettings(override);
    expect(out.syncBranch).toBe(DEFAULT_SYNC_SETTINGS.syncBranch);
    expect(out.upstreamRemote).toBe(DEFAULT_SYNC_SETTINGS.upstreamRemote);
    expect(out.forkRemote).toBe(DEFAULT_SYNC_SETTINGS.forkRemote);
    expect(out.opencodeModel).toBe(DEFAULT_SYNC_SETTINGS.opencodeModel);
  });
});

describe("release tags", () => {
  it("accepts plain releases only", () => {
    for (const tag of ["v1.34.0", "v0.0.1", "v10.20.30"]) {
      expect(isReleaseTag(tag)).toBe(true);
    }
    for (const tag of [
      "v1.23.0-r2",
      "v1.9.0-rc1",
      "v1.34",
      "v2",
      "ver1.2.3",
      "1.34.0",
      "v1.34.0-dirty",
      "latest",
      "",
      undefined,
    ]) {
      expect(isReleaseTag(tag)).toBe(false);
    }
  });

  it("parses a release tag into numbers", () => {
    expect(parseReleaseTag("v1.34.0")).toEqual([1, 34, 0]);
    expect(parseReleaseTag("v1.34.0-r2")).toBeNull();
  });

  it("orders numerically, not as text", () => {
    expect(compareReleaseTags("v1.10.0", "v1.9.0")).toBeGreaterThan(0);
    expect(compareReleaseTags("v1.34.1", "v1.34.10")).toBeLessThan(0);
    expect(compareReleaseTags("v1.34.0", "v1.34.0")).toBe(0);
    // a non-release tag never outranks a release
    expect(compareReleaseTags("zzz", "v1.0.0")).toBeLessThan(0);
  });

  it("picks the newest release and ignores odd tags", () => {
    expect(
      newestReleaseTag([
        "v1.34.0",
        "v1.35.0",
        "v1.23.0-r2",
        "v1.9.0",
        "v1.10.0",
        "v2",
        "ver1.2.3",
        "latest",
      ]),
    ).toBe("v1.35.0");
  });

  it("de-duplicates and tolerates an empty or all-junk list", () => {
    expect(newestReleaseTag(["v1.0.0", "v1.0.0"])).toBe("v1.0.0");
    expect(newestReleaseTag([])).toBeNull();
    expect(newestReleaseTag(["v1.2.0-r1", "nightly"])).toBeNull();
    expect(newestReleaseTag(undefined)).toBeNull();
  });
});

describe("backup branches", () => {
  const date = new Date(2026, 10, 4, 9, 5, 3); // local time, no TZ surprises

  it("builds backup/<branch>-<yyyymmdd-HHMMss>", () => {
    expect(backupBranchName("main", date)).toBe("backup/main-20261104-090503");
    expect(backupBranchName("custom/self-update", date)).toBe(
      "backup/custom/self-update-20261104-090503",
    );
  });

  it("recognises the names it generates", () => {
    expect(isBackupBranchName(backupBranchName("main", date))).toBe(true);
    expect(isBackupBranchName(backupBranchName("custom/x", date))).toBe(true);
  });

  it("rejects anything else", () => {
    for (const name of [
      "main",
      "backup/main",
      "backup/main-20261104",
      "backup/main-20261104-090503; rm -rf",
      "backup/main-20261104-090503..x",
      "refs/heads/backup/main-20261104-090503",
      "",
      undefined,
    ]) {
      expect(isBackupBranchName(name)).toBe(false);
    }
  });
});

describe("agent command lines", () => {
  const TASK =
    "C:\\Users\\me\\AppData\\Local\\AgentCanvasBuilds\\sync-task-1.md";

  it("knows exactly two agents", () => {
    expect([...AGENT_KINDS].sort()).toEqual(["claude", "opencode"]);
  });

  it("keeps the prompt a single short line pointing at the task file", () => {
    const prompt = agentPrompt(TASK);
    expect(prompt).toContain(TASK);
    expect(prompt.split("\n")).toHaveLength(1);
  });

  it("builds the opencode line", () => {
    const r = agentCommandLine({
      kind: "opencode",
      model: "ax_h200/selfhosted-model#xhigh",
      taskFile: TASK,
    });
    expect(r.exe).toBe("opencode");
    expect(r.args.slice(0, 6)).toEqual([
      "run",
      "--auto",
      "-m",
      "ax_h200/selfhosted-model#xhigh",
      "--title",
      "agent-canvas-rebase",
    ]);
    expect(r.args[r.args.length - 1]).toContain(TASK);
  });

  it("builds the Claude Code line", () => {
    const r = agentCommandLine({ kind: "claude", taskFile: TASK });
    expect(r.exe).toBe("claude");
    expect(r.args[0]).toBe("-p");
    expect(r.args).toContain("--permission-mode");
    expect(r.args).toContain("acceptEdits");
    expect(r.args).toContain("Bash(git *)");
    expect(r.args).toContain("Bash(npm *)");
    expect(r.args).toContain("Bash(npx *)");
  });

  it.each([
    { kind: "powershell", taskFile: TASK },
    { kind: "git", taskFile: TASK },
    { kind: "opencode", model: "bad model; calc", taskFile: TASK },
    { kind: "opencode", model: "", taskFile: TASK },
    { kind: "opencode", model: undefined, taskFile: TASK },
    { kind: "claude", taskFile: "" },
    { kind: "claude", taskFile: "line1\nline2" },
    { kind: "claude", taskFile: undefined },
  ])("refuses %j", (input) => expect(agentCommandLine(input)).toBeNull());
});

describe("syncTaskText", () => {
  const text = syncTaskText({
    repoPath: "C:\\Projects\\personal\\OpenHands",
    branch: "main",
    targetTag: "v1.35.0",
    backupBranch: "backup/main-20261104-090503",
    conflictedFiles: ["electron/main.mjs", "src/i18n/translation.json"],
  });

  it("carries every fact the agent needs", () => {
    expect(text).toContain("C:\\Projects\\personal\\OpenHands");
    expect(text).toContain("main");
    expect(text).toContain("v1.35.0");
    expect(text).toContain("backup/main-20261104-090503");
    expect(text).toContain("electron/main.mjs");
    expect(text).toContain("src/i18n/translation.json");
  });

  it("lists the fork's own files", () => {
    for (const file of FORK_FILES) expect(text).toContain(file);
    expect(FORK_FILES).toContain("electron/self-update.mjs");
    expect(FORK_FILES).toContain("src/i18n/translation.json");
  });

  it("states the rules: keep the fork, continue the rebase, checks, no push", () => {
    expect(text).toContain("Keep the fork's behaviour");
    expect(text).toContain("git rebase --continue");
    expect(text).toContain("GIT_EDITOR=true");
    expect(text).toContain("npm run typecheck");
    expect(text).toContain("npm run check-translation-completeness");
    expect(text).toContain(
      "vitest run electron/lib src/components/features/settings",
    );
    expect(text).toContain("git add");
    expect(text).toContain("Never push");
    expect(text).toContain("git rebase --abort");
    expect(text).toContain("npm run check-translation-completeness");
  });

  it("sends the agent to the fork's i18n merger before it edits anything", () => {
    expect(text).toContain("node scripts/resolve-translation-conflict.mjs");
    expect(text).toContain(
      "src/i18n/translation.json` is in the conflicted list",
    );
    // The shortcut has to come before the rules it replaces for that file.
    expect(text.indexOf("resolve-translation-conflict.mjs")).toBeLessThan(
      text.indexOf("## Rules"),
    );
  });

  it("says so when git listed no files", () => {
    const t = syncTaskText({
      repoPath: "R",
      branch: "main",
      targetTag: "v1.35.0",
      backupBranch: "backup/main-20261104-090503",
    });
    expect(t).toContain("run `git status`");
  });
});

describe("describeFetchFailure", () => {
  it("quotes the tag git refused to move and names it as the fix", () => {
    const err = [
      "Fetching upstream",
      "! [rejected]          v1.34.0 -> v1.34.0  (would clobber existing tag)",
      "error: failed to fetch 'upstream'",
    ].join("\n");
    const line = describeFetchFailure(err);
    expect(line).toContain("! [rejected]");
    expect(line).toContain("(would clobber existing tag)");
    expect(line).toContain("delete or rename v1.34.0");
  });

  it("lists every rejected tag once", () => {
    const err = [
      "! [rejected] v1.0.0 -> v1.0.0 (would clobber existing tag)",
      "! [rejected] v1.1.0 -> v1.1.0 (would clobber existing tag)",
    ].join("\n");
    const line = describeFetchFailure(err);
    expect(line).toContain("delete or rename v1.0.0, v1.1.0");
    expect(line.match(/! \[rejected]/g)).toHaveLength(2);
  });

  it("passes any other failure through as it came", () => {
    expect(describeFetchFailure("fatal: unable to access 'https://x/'")).toBe(
      "fatal: unable to access 'https://x/'",
    );
  });

  it("never returns an empty reason", () => {
    expect(describeFetchFailure("")).toBe("the fetch failed");
    expect(describeFetchFailure(null)).toBe("the fetch failed");
    expect(describeFetchFailure("  \n  ")).toBe("the fetch failed");
  });
});

describe("pushArgs", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("leases the branch on the sha recorded before the sync", () => {
    expect(
      pushArgs({
        forkRemote: "origin",
        branch: "main",
        expectedRemoteSha: SHA,
      }),
    ).toEqual(["push", `--force-with-lease=main:${SHA}`, "origin", "main"]);
  });

  it("leases the branch itself when it was never pushed", () => {
    expect(
      pushArgs({
        forkRemote: "fork",
        branch: "custom/x",
        expectedRemoteSha: null,
      }),
    ).toEqual(["push", "--force-with-lease=custom/x", "fork", "custom/x"]);
  });

  it.each([
    { forkRemote: "origin", branch: "main", expectedRemoteSha: "deadbeef" },
    { forkRemote: "origin", branch: "main", expectedRemoteSha: "x".repeat(40) },
    { forkRemote: "origin", branch: "main; rm", expectedRemoteSha: null },
    { forkRemote: "../origin", branch: "main", expectedRemoteSha: null },
    { forkRemote: "", branch: "main", expectedRemoteSha: null },
    { forkRemote: 1, branch: "main", expectedRemoteSha: null },
  ])("refuses %j", (input) => expect(pushArgs(input)).toBeNull());
});

describe("branchFromHeadName", () => {
  it("reads the branch out of git's head-name ref", () => {
    expect(branchFromHeadName("refs/heads/main\n")).toBe("main");
    expect(branchFromHeadName(" refs/heads/feature/sync-branch ")).toBe(
      "feature/sync-branch",
    );
  });

  it.each([
    "",
    "   ",
    "HEAD",
    "refs/remotes/upstream/main",
    "refs/heads/",
    undefined,
    7,
  ])("is null for %j", (value) => expect(branchFromHeadName(value)).toBeNull());
});

describe("deriveSyncPhase", () => {
  const repo = {
    gitFound: true,
    repoPath: "C:\\repo",
    // The caller resolves this: during a paused rebase the clone sits on a
    // detached HEAD and the branch comes from git's rebase state file.
    onSyncBranch: true,
    rebaseInProgress: false,
    clean: true,
    branchContainsTarget: false,
    installedSha: "a".repeat(40),
    headSha: "b".repeat(40),
    updateAvailable: true,
  };
  const state = {
    latestTag: "v1.35.0",
    backupBranch: "backup/main-20261104-090503",
    originSha: null,
    pushed: false,
  };

  it("is unavailable without git or a clone", () => {
    expect(
      deriveSyncPhase({ state: null, repo: { ...repo, gitFound: false } }),
    ).toBe("unavailable");
    expect(
      deriveSyncPhase({ state: null, repo: { ...repo, repoPath: null } }),
    ).toBe("unavailable");
  });

  it("is wrongBranch when the clone sits on another branch", () => {
    expect(
      deriveSyncPhase({ state, repo: { ...repo, onSyncBranch: false } }),
    ).toBe("wrongBranch");
  });

  it("is conflict whenever a rebase is in progress, whatever else is true", () => {
    expect(
      deriveSyncPhase({
        state: null,
        repo: { ...repo, rebaseInProgress: true },
      }),
    ).toBe("conflict");
    expect(
      deriveSyncPhase({
        state: { ...state, pushed: true },
        repo: { ...repo, rebaseInProgress: true, branchContainsTarget: true },
      }),
    ).toBe("conflict");
  });

  it("is conflict on git-faithful paused-rebase facts", () => {
    // `rev-parse --abbrev-ref HEAD` says "HEAD" there, the tree is dirty with
    // conflict markers and the target is not in the branch yet: still conflict.
    expect(
      deriveSyncPhase({
        state,
        repo: {
          ...repo,
          rebaseInProgress: true,
          onSyncBranch: true,
          clean: false,
          branchContainsTarget: false,
          installedSha: null,
          updateAvailable: true,
        },
      }),
    ).toBe("conflict");
  });

  it("is available / upToDate with no sync in flight", () => {
    expect(deriveSyncPhase({ state: null, repo })).toBe("available");
    expect(
      deriveSyncPhase({
        state: null,
        repo: { ...repo, updateAvailable: false },
      }),
    ).toBe("upToDate");
  });

  it("goes back to available when the rebase was resolved or rolled back outside the app", () => {
    expect(deriveSyncPhase({ state, repo })).toBe("available");
    expect(
      deriveSyncPhase({ state, repo: { ...repo, updateAvailable: false } }),
    ).toBe("upToDate");
  });

  it("is rebased once the branch carries the tag and the tree is clean", () => {
    expect(
      deriveSyncPhase({ state, repo: { ...repo, branchContainsTarget: true } }),
    ).toBe("rebased");
  });

  it("is dirty when the tree still has changes after the rebase", () => {
    expect(
      deriveSyncPhase({
        state,
        repo: { ...repo, branchContainsTarget: true, clean: false },
      }),
    ).toBe("dirty");
  });

  it("is installed when the running build is the rebased HEAD", () => {
    expect(
      deriveSyncPhase({
        state,
        repo: {
          ...repo,
          branchContainsTarget: true,
          installedSha: "b".repeat(40),
        },
      }),
    ).toBe("installed");
  });

  it("has no pushed phase: a pushed record reads as the phase the branch is in", () => {
    // Push clears the record and writes the display-only `lastSync`, so nothing
    // ever reaches `pushed` here. A stale record that still carries the flag must
    // not invent a phase the panel cannot act on.
    expect(
      deriveSyncPhase({
        state: { ...state, pushed: true },
        repo: { ...repo, branchContainsTarget: true },
      }),
    ).toBe("rebased");
    expect(
      deriveSyncPhase({
        state: { ...state, pushed: true },
        repo: {
          ...repo,
          branchContainsTarget: true,
          installedSha: "b".repeat(40),
        },
      }),
    ).toBe("installed");
  });

  it("does not call a stale build installed", () => {
    // installedSha null (dev run / no build-info): never "installed".
    expect(
      deriveSyncPhase({
        state,
        repo: {
          ...repo,
          branchContainsTarget: true,
          installedSha: null,
        },
      }),
    ).toBe("rebased");
  });
});
