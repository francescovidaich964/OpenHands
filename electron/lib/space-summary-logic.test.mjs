import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  FIRST_SUMMARY_PROMPT_PREFIX,
  INCREMENTAL_SUMMARY_PROMPT_PREFIX,
  SUMMARY_SYSTEM_PROMPT,
  TRUNCATED_TEXT_LINE,
  TRANSCRIPT_CHAR_LIMIT,
  buildClaudeArgs,
  buildSummaryPrompt,
  formatTranscript,
  isSafeModelName,
  isSafeSessionId,
  isSafeSummaryKey,
  mergeSummarySettings,
  normalizeTranscriptMessages,
  omittedMessagesLine,
  parseClaudeResult,
  parseSummaryIndex,
  publicSummarySettings,
  resolveClaudeCommand,
  resolveSummarySettings,
  summaryModeFor,
  upsertSummaryEntry,
} from "./space-summary-logic.mjs";

const SESSION = "11111111-2222-3333-4444-555555555555";

describe("buildClaudeArgs", () => {
  it("runs a tool-less, MCP-less, settings-less headless call", () => {
    const args = buildClaudeArgs({ settings: { model: "opus" } });
    expect(args.slice(0, 2)).toEqual(["-p", "--model"]);
    expect(args[2]).toBe("opus");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).toContain("--system-prompt");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(
      SUMMARY_SYSTEM_PROMPT,
    );
    expect(args).toContain("--strict-mcp-config");
    // No tools at all: the summariser must not act.
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    // No user/project settings, so the user's hooks and CLAUDE.md never run.
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    // --bare refuses OAuth/keychain auth, which is the login we depend on.
    expect(args).not.toContain("--bare");
  });

  it("continues the same summariser session when it has one", () => {
    const args = buildClaudeArgs({ settings: {}, sessionId: SESSION });
    expect(args.slice(-2)).toEqual(["--resume", SESSION]);
  });

  it("drops an unsafe session id instead of putting it in argv", () => {
    const args = buildClaudeArgs({
      settings: {},
      sessionId: "--include-paths /",
    });
    expect(args).not.toContain("--resume");
  });

  it("falls back to the default model for anything odd", () => {
    expect(buildClaudeArgs({ settings: { model: "a b --foo" } })[2]).toBe(
      DEFAULT_MODEL,
    );
    expect(buildClaudeArgs({})[2]).toBe(DEFAULT_MODEL);
  });
});

describe("parseClaudeResult", () => {
  it("reads the digest and the session id from the json envelope", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "  ## Overview\n did things \n",
      session_id: SESSION,
    });
    expect(parseClaudeResult(stdout)).toEqual({
      summary: "## Overview\n did things",
      sessionId: SESSION,
    });
  });

  it("keeps an empty session id rather than inventing one", () => {
    const parsed = parseClaudeResult(JSON.stringify({ result: "x" }));
    expect(parsed.sessionId).toBe("");
  });

  it("fails loudly on non-JSON, errors and empty text", () => {
    expect(() => parseClaudeResult("plain text")).toThrow(/not JSON/);
    expect(() =>
      parseClaudeResult(JSON.stringify({ result: "ok" })),
    ).not.toThrow();
    expect(() =>
      parseClaudeResult(
        JSON.stringify({ is_error: true, subtype: "error_during_execution" }),
      ),
    ).toThrow(/failed/);
    expect(() => parseClaudeResult(JSON.stringify({ result: "   " }))).toThrow(
      /no text/,
    );
  });
});

describe("formatTranscript", () => {
  const message = (role, text) => ({ role, text });

  it("uses Devin's message headers and numbering", () => {
    const text = formatTranscript([
      message("User", "hello"),
      message("Assistant", "hi"),
    ]);
    expect(text).toBe(
      "=== MESSAGE 1 - User ===\nhello\n=== MESSAGE 2 - Assistant ===\nhi",
    );
  });

  it("keeps Devin's numbering when a refresh sends only the new messages", () => {
    const text = formatTranscript([message("User", "more")], 12);
    expect(text).toBe("=== MESSAGE 13 - User ===\nmore");
  });

  it("caps the transcript with a head/tail split and an omission line", () => {
    const pad = "x".repeat(2_000);
    const messages = Array.from({ length: 12 }, (_, i) =>
      message(i % 2 ? "Assistant" : "User", `m${i} ${pad}`),
    );
    const text = formatTranscript(messages, 0, 20_000);
    expect(text).toContain("=== MESSAGE 1 - User ===");
    expect(text).toContain(omittedMessagesLine(6));
    expect(text).toContain("=== MESSAGE 12 - Assistant ===");
    // the head quarter + tail quarter of the budget leave the middle out
    expect(text).not.toContain("=== MESSAGE 7 ");
  });

  it("still cuts the text when a single message is bigger than the head", () => {
    const text = formatTranscript(
      [
        message("User", "a".repeat(50_000)),
        message("Assistant", "b".repeat(50_000)),
      ],
      0,
      20_000,
    );
    expect(text).toContain("=== MESSAGE 1 - User ===");
    expect(text).toContain(TRUNCATED_TEXT_LINE);
    // head half + the line + tail quarter, never the whole thing
    expect(text.length).toBeLessThan(16_000);
  });

  it("cuts the text itself when no whole message fits", () => {
    const text = formatTranscript([message("User", "y".repeat(4000))], 0, 1000);
    expect(text).toContain(TRUNCATED_TEXT_LINE);
    expect(text.length).toBeLessThanOrEqual(1000 + 60);
    expect(text).toContain("y".repeat(400));
  });

  it("returns an empty transcript for no messages", () => {
    expect(formatTranscript([])).toBe("");
  });
});

describe("normalizeTranscriptMessages", () => {
  it("keeps only the labelled roles with text", () => {
    expect(
      normalizeTranscriptMessages([
        { role: "User", text: "hi" },
        { role: "Assistant", text: "  " },
        { role: "Tool", text: "output" },
        { role: "user", text: "lowercase" },
        null,
        "nope",
        { role: "Assistant", text: "done" },
      ]),
    ).toEqual([
      { role: "User", text: "hi" },
      { role: "Assistant", text: "done" },
    ]);
  });

  it("is not confused by a non-array payload", () => {
    expect(normalizeTranscriptMessages(undefined)).toEqual([]);
    expect(
      normalizeTranscriptMessages({ 0: { role: "User", text: "x" } }),
    ).toEqual([]);
  });
});

describe("summaryModeFor", () => {
  it("only continues a session it can actually resume", () => {
    expect(summaryModeFor({}, "c1")).toBe("initial");
    expect(
      summaryModeFor({ c1: { messageCount: 4, claudeSessionId: "" } }, "c1"),
    ).toBe("initial");
    expect(
      summaryModeFor(
        { c1: { messageCount: 0, claudeSessionId: SESSION } },
        "c1",
      ),
    ).toBe("initial");
    expect(
      summaryModeFor(
        { c1: { messageCount: 4, claudeSessionId: SESSION } },
        "c1",
      ),
    ).toBe("incremental");
  });
});

describe("parseSummaryIndex / upsertSummaryEntry", () => {
  it("repairs a damaged index instead of trusting it", () => {
    expect(parseSummaryIndex("")).toEqual({});
    expect(parseSummaryIndex("{ not json")).toEqual({});
    expect(parseSummaryIndex("[1,2]")).toEqual({});
    expect(
      parseSummaryIndex(
        JSON.stringify({
          "../evil": { messageCount: 3 },
          c1: { messageCount: "7", claudeSessionId: SESSION, extra: 1 },
          c2: { messageCount: -2 },
          c3: "nope",
        }),
      ),
    ).toEqual({
      c1: { messageCount: 7, claudeSessionId: SESSION, updatedMs: 0 },
    });
  });

  it("keeps the previous session id when a result omits one", () => {
    const index = {
      c1: { messageCount: 2, claudeSessionId: SESSION, updatedMs: 1 },
    };
    const next = upsertSummaryEntry(index, "c1", {
      messageCount: 9,
      claudeSessionId: "",
      updatedMs: 5,
    });
    expect(next.c1).toEqual({
      messageCount: 9,
      claudeSessionId: SESSION,
      updatedMs: 5,
    });
    expect(index.c1.messageCount).toBe(2); // the old object is not mutated
  });

  it("refuses to key an entry by an unsafe conversation id", () => {
    expect(
      upsertSummaryEntry({}, "../x", { messageCount: 1 }).constructor,
    ).toBe(Object);
    expect(
      Object.keys(upsertSummaryEntry({}, "../x", { messageCount: 1 })),
    ).toEqual([]);
  });

  it("round-trips a written index", () => {
    const next = upsertSummaryEntry({}, "c1", {
      messageCount: 3,
      claudeSessionId: SESSION,
      updatedMs: 7,
    });
    expect(parseSummaryIndex(JSON.stringify(next))).toEqual(next);
  });
});

describe("settings", () => {
  it("defaults to the latest Opus, on, with no api key", () => {
    const settings = resolveSummarySettings({ stored: {}, env: {} });
    expect(settings.model).toBe("opus");
    expect(settings.enabled).toBe(true);
    expect(publicSummarySettings(settings)).toEqual({
      model: "opus",
      enabled: true,
    });
  });

  it("reads the stored file and the env override", () => {
    expect(
      resolveSummarySettings({
        stored: { model: "claude-opus-5-5", enabled: false },
      }).enabled,
    ).toBe(false);
    expect(
      resolveSummarySettings({
        env: { AGENT_CANVAS_SPACE_SUMMARY_MODEL: "claude-opus-5-5" },
      }).model,
    ).toBe("claude-opus-5-5");
    expect(
      resolveSummarySettings({
        stored: { model: "--dangerously-skip-permissions" },
      }).model,
    ).toBe(DEFAULT_MODEL);
  });

  it("merges a patch without inventing keys", () => {
    const merged = mergeSummarySettings(
      { model: "opus", enabled: true },
      {
        model: "sonnet",
        whatever: "x",
      },
    );
    expect(merged).toEqual({ model: "sonnet", enabled: true });
    expect(mergeSummarySettings({}, { enabled: false }).enabled).toBe(false);
    expect(
      mergeSummarySettings({ enabled: false }, { enabled: "yes" }).enabled,
    ).toBe(false);
  });

  it("reports the prompt prefixes Devin uses", () => {
    expect(FIRST_SUMMARY_PROMPT_PREFIX).toBe(
      "Output a summary from the following messages:\n\n",
    );
    expect(INCREMENTAL_SUMMARY_PROMPT_PREFIX).toBe(
      "Output a new summary with the following new messages from the same conversation:\n\n",
    );
    expect(buildSummaryPrompt({ transcript: "T", incremental: true })).toBe(
      `${INCREMENTAL_SUMMARY_PROMPT_PREFIX}T`,
    );
    expect(SUMMARY_SYSTEM_PROMPT).toContain("Summarizer");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("Key Details & Breadcrumbs");
  });

  it("keeps the cap Devin's transcript uses", () => {
    expect(TRANSCRIPT_CHAR_LIMIT).toBe(200_000);
  });
});

describe("resolveClaudeCommand", () => {
  const env = { PATH: ["C:\\tools", "C:\\Users\\me\\.local\\bin"].join(";") };

  it("prefers an explicitly configured binary", () => {
    expect(
      resolveClaudeCommand({ settings: { command: "C:\\claude.exe" }, env }),
    ).toEqual({ command: "C:\\claude.exe", needsShell: false });
    expect(
      resolveClaudeCommand({ settings: { command: "C:\\claude.cmd" }, env })
        .needsShell,
    ).toBe(true);
  });

  it("prefers the native exe over a .cmd shim in the same directory", () => {
    const both = resolveClaudeCommand({
      settings: {},
      env: { PATH: "C:\\tools" },
      exists: () => true,
    });
    expect(both).toEqual({
      command: join("C:\\tools", "claude.exe"),
      needsShell: false,
    });
  });

  it("takes whatever the first PATH directory offers, even a shim", () => {
    const found = resolveClaudeCommand({
      settings: {},
      env,
      exists: (candidate) => candidate === join("C:\\tools", "claude.cmd"),
    });
    expect(found).toEqual({
      command: join("C:\\tools", "claude.cmd"),
      needsShell: true,
    });
  });

  it("says so when nothing was found", () => {
    expect(resolveClaudeCommand({ settings: {}, env: {} })).toEqual({
      command: "",
      needsShell: false,
    });
  });

  it("looks for a plain name off PATH on linux", () => {
    expect(
      resolveClaudeCommand({
        settings: {},
        env: { PATH: "/usr/local/bin:/usr/bin" },
        platform: "linux",
        exists: (candidate) => candidate === join("/usr/local/bin", "claude"),
      }),
    ).toEqual({ command: join("/usr/local/bin", "claude"), needsShell: false });
  });
});

describe("safety predicates", () => {
  it("accepts ids and rejects path-ish ones", () => {
    expect(isSafeSummaryKey("abc-123_DEF.4")).toBe(true);
    for (const bad of ["", "../x", "a/b", "a\\b", "a:b", "x".repeat(300)]) {
      expect(isSafeSummaryKey(bad)).toBe(false);
    }
    expect(isSafeSessionId(SESSION)).toBe(true);
    expect(isSafeSessionId("--resume")).toBe(false);
    // A stored value must never reach the CLI as a flag of its own.
    expect(isSafeSessionId("--output-format")).toBe(false);
    expect(isSafeModelName("--dangerously-skip-permissions")).toBe(false);
    expect(isSafeModelName("claude-opus-5-5")).toBe(true);
    expect(isSafeModelName("two words")).toBe(false);
  });
});
