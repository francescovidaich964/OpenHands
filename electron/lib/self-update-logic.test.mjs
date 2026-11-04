import { describe, expect, it } from "vitest";

import {
  archiveFileName,
  findNewestInstaller,
  isArchivedInstallerPath,
  isTrustedSender,
  lastInstallRun,
  parseArchiveFileName,
  parseLogLines,
  resolveRepoPath,
  selectArchiveToPrune,
  sortArchive,
  splitChunk,
  trimLog,
} from "./self-update-logic.mjs";
import { isLoopbackAppUrl } from "./window-url-policy.mjs";

const ARCHIVE = "C:\\Users\\me\\AppData\\Local\\AgentCanvasBuilds";

describe("archive names", () => {
  it("round-trips version and sha", () => {
    const name = archiveFileName("1.34.0", "6c12007");
    expect(name).toBe("Agent-Canvas-Setup-1.34.0-6c12007.exe");
    expect(parseArchiveFileName(name)).toEqual({
      version: "1.34.0",
      sha: "6c12007",
    });
  });

  it("handles prerelease versions", () => {
    expect(
      parseArchiveFileName("Agent-Canvas-Setup-1.35.0-rc.1-abcdef0.exe"),
    ).toEqual({ version: "1.35.0-rc.1", sha: "abcdef0" });
  });

  it("rejects unrelated files", () => {
    expect(parseArchiveFileName("install.log")).toBeNull();
    expect(parseArchiveFileName("Agent-Canvas-Setup-1.0.0.exe")).toBeNull();
  });
});

describe("isArchivedInstallerPath", () => {
  it("accepts an exe directly inside the archive directory", () => {
    expect(
      isArchivedInstallerPath(
        `${ARCHIVE}\\Agent-Canvas-Setup-1.0.0-abc1234.exe`,
        ARCHIVE,
      ),
    ).toBe(true);
  });

  it("is case-insensitive about the directory", () => {
    expect(
      isArchivedInstallerPath(
        `${ARCHIVE.toUpperCase()}\\Agent-Canvas-Setup-1.0.0-abc1234.exe`,
        ARCHIVE,
      ),
    ).toBe(true);
  });

  const NAME = "Agent-Canvas-Setup-1.0.0-abc1234.exe";
  it.each([
    `${ARCHIVE}\\..\\${NAME}`,
    `${ARCHIVE}\\sub\\${NAME}`,
    `${ARCHIVE}-evil\\${NAME}`,
    "C:\\Windows\\System32\\cmd.exe",
    `${ARCHIVE}\\x.exe`,
    `${ARCHIVE}\\OpenHands-Agent-Canvas-Setup-1.0.0.exe`,
    `${ARCHIVE}\\x.ps1`,
    `${ARCHIVE}\\${NAME}.bat`,
    ARCHIVE,
    "",
    `${ARCHIVE}\\x\0.exe`,
  ])("rejects %j", (p) => {
    expect(isArchivedInstallerPath(p, ARCHIVE)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isArchivedInstallerPath(undefined, ARCHIVE)).toBe(false);
    expect(isArchivedInstallerPath({}, ARCHIVE)).toBe(false);
  });
});

describe("findNewestInstaller", () => {
  const T = 1_000;
  it("returns the newest setup exe written after the build started", () => {
    const hit = findNewestInstaller(
      [
        { name: "OpenHands-Agent-Canvas-Setup-1.0.0.exe", mtimeMs: T + 50 },
        { name: "OpenHands-Agent-Canvas-Setup-0.9.0.exe", mtimeMs: T + 10 },
        { name: "builder-debug.yml", mtimeMs: T + 99 },
      ],
      T,
    );
    expect(hit.name).toBe("OpenHands-Agent-Canvas-Setup-1.0.0.exe");
  });

  it("ignores stale installers from before the build", () => {
    expect(
      findNewestInstaller(
        [{ name: "OpenHands-Agent-Canvas-Setup-1.0.0.exe", mtimeMs: T - 1 }],
        T,
      ),
    ).toBeNull();
  });

  it("ignores the uninstaller stub and blockmaps", () => {
    expect(
      findNewestInstaller(
        [
          { name: "X-Setup-1.0.0.__uninstaller.exe", mtimeMs: T + 5 },
          { name: "X-Setup-1.0.0.exe.blockmap", mtimeMs: T + 5 },
        ],
        T,
      ),
    ).toBeNull();
  });
});

describe("archive pruning", () => {
  const mk = (n, t) => ({
    name: archiveFileName("1.0.0", `abc000${n}`),
    mtimeMs: t,
  });

  const entries = [mk(1, 1), mk(2, 2), mk(3, 3), mk(4, 4), mk(5, 5)];
  const index = {
    [mk(1, 1).name]: { branch: "main" },
    [mk(2, 2).name]: { branch: "main" },
    [mk(3, 3).name]: { branch: "custom/feature" },
    // mk(4) has no record: built before the index existed
    [mk(5, 5).name]: { branch: "custom/other" },
  };

  it("keeps only the build just made and the newest main build", () => {
    expect(
      selectArchiveToPrune(entries, { keepName: mk(5, 5).name, index }).sort(),
    ).toEqual([mk(1, 1).name, mk(3, 3).name, mk(4, 4).name].sort());
  });

  it("keeps the pre-sync main build while a sync is unfinished", () => {
    expect(
      selectArchiveToPrune(entries, {
        keepName: mk(5, 5).name,
        index,
        anchorKeep: 2,
      }).sort(),
    ).toEqual([mk(3, 3).name, mk(4, 4).name].sort());
  });

  it("follows the configured anchor branch", () => {
    expect(
      selectArchiveToPrune(entries, {
        keepName: mk(5, 5).name,
        index,
        anchorBranch: "custom/feature",
      }).sort(),
    ).toEqual([mk(1, 1).name, mk(2, 2).name, mk(4, 4).name].sort());
  });

  it("keeps just the new build when no main build exists", () => {
    expect(
      selectArchiveToPrune([mk(4, 4), mk(5, 5)], { keepName: mk(5, 5).name }),
    ).toEqual([mk(4, 4).name]);
  });

  it("never touches files that are not archive installers", () => {
    const withOthers = [
      { name: "install.log", mtimeMs: 0 },
      { name: "archive-index.json", mtimeMs: 0 },
      mk(1, 1),
    ];
    expect(selectArchiveToPrune(withOthers, {})).toEqual([mk(1, 1).name]);
  });

  it("sortArchive is newest first", () => {
    expect(
      sortArchive([mk(1, 1), mk(2, 9), mk(3, 5)]).map((e) => e.mtimeMs),
    ).toEqual([9, 5, 1]);
  });
});

describe("log helpers", () => {
  it("trims to the last N lines", () => {
    expect(trimLog(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
  });

  it("splitChunk carries a partial line over", () => {
    const a = splitChunk("", "one\ntw");
    expect(a).toEqual({ lines: ["one"], rest: "tw" });
    const b = splitChunk(a.rest, "o\nthree\n");
    expect(b).toEqual({ lines: ["two", "three"], rest: "" });
  });

  it("splitChunk strips ANSI and collapses \\r progress frames", () => {
    const { lines } = splitChunk("", "\x1b[32mok\x1b[0m\n10%\r50%\r100%\n");
    expect(lines).toEqual(["ok", "100%"]);
  });

  it("parseLogLines drops blanks", () => {
    expect(parseLogLines("abc one\r\n\r\ndef two\n")).toEqual([
      "abc one",
      "def two",
    ]);
    expect(parseLogLines(undefined)).toEqual([]);
  });
});

describe("resolveRepoPath", () => {
  it("prefers the userData override", () => {
    expect(resolveRepoPath({ repoPath: "C:\\a" }, { repoPath: "D:\\b" })).toBe(
      "D:\\b",
    );
  });
  it("falls back to the build-time path", () => {
    expect(resolveRepoPath({ repoPath: "C:\\a" }, null)).toBe("C:\\a");
    expect(resolveRepoPath({ repoPath: "C:\\a" }, { repoPath: "  " })).toBe(
      "C:\\a",
    );
  });
  it("is null when neither is available", () => {
    expect(resolveRepoPath(null, null)).toBeNull();
    expect(resolveRepoPath({}, {})).toBeNull();
  });
});

describe("isTrustedSender", () => {
  const base = {
    senderIsMainWindow: true,
    senderIsMainFrame: true,
    senderUrl: "http://localhost:8000/settings/app",
    isLoopbackAppUrl,
  };
  it("accepts the app's own page", () => {
    expect(isTrustedSender(base)).toBe(true);
  });
  it.each([
    { senderIsMainWindow: false },
    { senderIsMainFrame: false },
    { senderUrl: "https://evil.example/" },
    { senderUrl: "http://localhost.evil.com/" },
    { senderUrl: undefined },
  ])("rejects %j", (patch) => {
    expect(isTrustedSender({ ...base, ...patch })).toBe(false);
  });
});

describe("lastInstallRun", () => {
  const log = [
    "2026-11-01 10:00:00  helper started: installer=A appPid=1",
    "2026-11-01 10:00:09  installer exit code: 0",
    "2026-11-01 10:00:11  helper done",
    "",
    "2026-11-02 10:00:00  helper started: installer=B appPid=2",
    "2026-11-02 10:01:00  ABORT: app (pid 2) still running after 60 s",
    "2026-11-02 10:01:02  helper done",
  ].join("\r\n");

  it("returns only the most recent run", () => {
    const run = lastInstallRun(log);
    expect(run).toHaveLength(3);
    expect(run[0]).toContain("installer=B");
    expect(run[2]).toContain("helper done");
  });

  it("caps the number of lines", () => {
    expect(lastInstallRun(log, 2)).toEqual([
      "2026-11-02 10:01:00  ABORT: app (pid 2) still running after 60 s",
      "2026-11-02 10:01:02  helper done",
    ]);
  });

  it("is empty without a helper run", () => {
    expect(lastInstallRun("")).toEqual([]);
    expect(lastInstallRun(undefined)).toEqual([]);
    expect(lastInstallRun("some other line")).toEqual([]);
  });
});
