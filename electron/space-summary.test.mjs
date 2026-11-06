import { EventEmitter } from "node:events";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The module under test uses named imports; `default` is there for the
// interop the module runner asks for.
vi.mock("node:child_process", () => {
  const childProcess = { spawn: vi.fn() };
  return { ...childProcess, default: childProcess };
});
vi.mock("node:fs", () => {
  const fs = {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  return { ...fs, default: fs };
});

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { registerSpaceSummary } from "./space-summary.mjs";

const USER_DATA = "C:\\UserData";
const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = "22222222-2222-3333-4444-555555555555";
const CONVERSATION = "11111111-aaaa-bbbb-cccc-dddddddddddd";

const SUMMARY_MD = join(USER_DATA, "space_summaries", `${CONVERSATION}.md`);
const INDEX_JSON = join(USER_DATA, "space_summaries", "index.json");
const SETTINGS_JSON = join(USER_DATA, "space-summary.json");

/** The whole file system this module touches, as a map. */
let files;

function trustedEvent() {
  const webContents = {
    mainFrame: { url: "http://127.0.0.1:9873/conversations" },
  };
  return {
    sender: webContents,
    senderFrame: webContents.mainFrame,
    __webContents: webContents,
  };
}

function windowFor(event) {
  return { isDestroyed: () => false, webContents: event.__webContents };
}

/** Registers the module against a fake ipcMain and returns its handlers. */
function register({ env = {}, window = null } = {}) {
  const handlers = new Map();
  const api = registerSpaceSummary({
    app: { getPath: () => USER_DATA },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getMainWindow: () => window,
    env: { AGENT_CANVAS_CLAUDE_COMMAND: "C:\\claude.exe", ...env },
  });
  return { api, handlers };
}

/** A `claude -p` child that answers with `payload` (or garbage). */
function answerWith(payload, { code = 0, raw } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (prompt) => {
    child.prompt = prompt;
  };
  child.kill = () => {};
  spawn.mockReturnValue(child);
  setImmediate(() => {
    child.stdout.emit(
      "data",
      Buffer.from(
        raw ??
          (typeof payload === "string" ? payload : JSON.stringify(payload)),
      ),
    );
    child.emit("close", code);
  });
  return child;
}

const okResult = (result, session_id = SESSION) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result,
  session_id,
});

const messages = (...texts) =>
  texts.map((text, index) => ({
    role: index % 2 ? "Assistant" : "User",
    text,
  }));

async function callSummarize(handlers, event, request) {
  return handlers.get("space-summary:summarize")(event, request);
}

beforeEach(() => {
  files = new Map();
  vi.clearAllMocks();
  existsSync.mockImplementation((path) => files.has(path));
  readFileSync.mockImplementation((path) => {
    if (!files.has(path)) throw new Error(`ENOENT ${path}`);
    return files.get(path);
  });
  writeFileSync.mockImplementation((path, data) =>
    files.set(path, String(data)),
  );
});

describe("space-summary IPC", () => {
  it("refuses a sender that is not the loopback main window", async () => {
    const event = trustedEvent();
    event.senderFrame.url = "http://evil.example/";
    const { api, handlers } = register({ window: windowFor(event) });
    const result = await callSummarize(handlers, event, {
      conversationId: CONVERSATION,
      messages: messages("hi"),
    });
    expect(result).toEqual({ ok: false, error: "untrusted sender" });
    expect(spawn).not.toHaveBeenCalled();

    // and with no main window at all
    const noWindow = register({ window: null });
    expect(
      await noWindow.handlers.get(api.CHANNEL.settings)(trustedEvent()),
    ).toEqual({ ok: false, error: "untrusted sender" });
  });

  it("summarizes a conversation from scratch and stores the pair", async () => {
    const event = trustedEvent();
    const { api, handlers } = register({
      window: windowFor(event),
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const child = answerWith(okResult("## Overview\nBuilt the thing."));

    const result = await callSummarize(handlers, event, {
      conversationId: CONVERSATION,
      messages: messages("do it", "done"),
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("## Overview\nBuilt the thing.");
    expect(result.messageCount).toBe(2);
    expect(result.incremental).toBe(false);

    // the digest is a file of its own, next to the index (Devin's layout)
    expect(files.get(SUMMARY_MD)).toBe("## Overview\nBuilt the thing.");
    expect(JSON.parse(files.get(INDEX_JSON))[CONVERSATION]).toEqual({
      messageCount: 2,
      claudeSessionId: SESSION,
      updatedMs: expect.any(Number),
    });

    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("C:\\claude.exe");
    expect(args).not.toContain("--resume");
    expect(options.cwd).toBe(join(USER_DATA, "space-summarizer"));
    // our own build flag must not leak into a Node-based CLI
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    // the transcript goes on stdin, with Devin's headers
    expect(
      child.prompt.startsWith("Output a summary from the following messages:"),
    ).toBe(true);
    expect(child.prompt).toContain("=== MESSAGE 1 - User ===\ndo it");
    expect(child.prompt).toContain("=== MESSAGE 2 - Assistant ===\ndone");
  });

  it("continues the same summariser session with only the new messages", async () => {
    const event = trustedEvent();
    const { handlers } = register({ window: windowFor(event) });
    files.set(
      INDEX_JSON,
      JSON.stringify({
        [CONVERSATION]: { messageCount: 2, claudeSessionId: SESSION },
      }),
    );
    files.set(SUMMARY_MD, "old digest");
    const child = answerWith(okResult("new digest", OTHER_SESSION));

    const result = await callSummarize(handlers, event, {
      conversationId: CONVERSATION,
      messages: messages("a", "b", "c"),
    });

    expect(result.ok).toBe(true);
    expect(result.incremental).toBe(true);
    expect(result.messageCount).toBe(3);
    expect(spawn.mock.calls[0][1].slice(-2)).toEqual(["--resume", SESSION]);
    expect(
      child.prompt.startsWith(
        "Output a new summary with the following new messages",
      ),
    ).toBe(true);
    expect(child.prompt).toContain("=== MESSAGE 3 - User ===\nc");
    expect(child.prompt).not.toContain("=== MESSAGE 1 -");
    expect(files.get(SUMMARY_MD)).toBe("new digest");
    expect(
      JSON.parse(files.get(INDEX_JSON))[CONVERSATION].claudeSessionId,
    ).toBe(OTHER_SESSION);
  });

  it("does not call the model again when nothing is new", async () => {
    const event = trustedEvent();
    const { handlers } = register({ window: windowFor(event) });
    files.set(
      INDEX_JSON,
      JSON.stringify({
        [CONVERSATION]: {
          messageCount: 2,
          claudeSessionId: SESSION,
          updatedMs: 5,
        },
      }),
    );
    files.set(SUMMARY_MD, "cached digest");

    const result = await callSummarize(handlers, event, {
      conversationId: CONVERSATION,
      messages: messages("a", "b"),
    });

    expect(result).toEqual({
      ok: true,
      unchanged: true,
      messageCount: 2,
      summary: "cached digest",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps the previous digest when the summariser fails", async () => {
    const event = trustedEvent();
    const { handlers } = register({ window: windowFor(event) });
    files.set(SUMMARY_MD, "digest from before");
    files.set(
      INDEX_JSON,
      JSON.stringify({
        [CONVERSATION]: { messageCount: 2, claudeSessionId: SESSION },
      }),
    );
    answerWith("not json at all", { code: 1 });

    const result = await callSummarize(handlers, event, {
      conversationId: CONVERSATION,
      messages: messages("a", "b", "c"),
    });

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(files.get(SUMMARY_MD)).toBe("digest from before");
    expect(JSON.parse(files.get(INDEX_JSON))[CONVERSATION].messageCount).toBe(
      2,
    );
  });

  it("refuses a conversation without an id and refuses to escape the folder", async () => {
    const event = trustedEvent();
    const { handlers } = register({ window: windowFor(event) });
    expect(
      await callSummarize(handlers, event, {
        conversationId: "",
        messages: messages("x"),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await callSummarize(handlers, event, {
        conversationId: "../../escape",
        messages: messages("x"),
      }),
    ).toMatchObject({ ok: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stays off when the setting says so, and remembers the setting", async () => {
    files.set(SETTINGS_JSON, JSON.stringify({ enabled: false }));
    const event = trustedEvent();
    const { api, handlers } = register({ window: windowFor(event) });

    expect(await handlers.get(api.CHANNEL.settings)(event)).toEqual({
      ok: true,
      settings: { model: "opus", enabled: false },
    });

    const failed = await callSummarize(handlers, event, {
      conversationId: CONVERSATION,
      messages: messages("x"),
    });
    expect(failed).toMatchObject({ ok: false, disabled: true });
    expect(spawn).not.toHaveBeenCalled();

    const saved = await handlers.get(api.CHANNEL.setSettings)(event, {
      enabled: true,
      model: "claude-opus-5-5",
      injected: "nope",
    });
    expect(saved).toEqual({
      ok: true,
      settings: { model: "claude-opus-5-5", enabled: true },
    });
    expect(JSON.parse(files.get(SETTINGS_JSON))).toEqual({
      enabled: true,
      model: "claude-opus-5-5",
    });
  });

  it("lists only digests whose file is still there", async () => {
    const event = trustedEvent();
    const { api, handlers } = register({ window: windowFor(event) });
    files.set(
      INDEX_JSON,
      JSON.stringify({
        [CONVERSATION]: {
          messageCount: 2,
          claudeSessionId: SESSION,
          updatedMs: 1_700_000_000_000,
        },
        [OTHER_SESSION]: {
          messageCount: 4,
          claudeSessionId: OTHER_SESSION,
          updatedMs: 1,
        },
      }),
    );
    files.set(SUMMARY_MD, "here");

    const listed = await handlers.get(api.CHANNEL.list)(event);
    expect(Object.keys(listed.summaries)).toEqual([CONVERSATION]);
    expect(listed.summaries[CONVERSATION]).toEqual({
      summary: "here",
      messageCount: 2,
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    });
  });
});
