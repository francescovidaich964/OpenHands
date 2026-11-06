/**
 * Spaces summariser IPC (fork-only feature). The renderer sends a formatted
 * transcript for one conversation; the main process runs one headless
 * `claude -p` call (the user's own Claude Code login — there is no key here)
 * and stores the digest as `<userData>/space_summaries/<conversationId>.md`
 * plus an index entry `{messageCount, claudeSessionId, updatedMs}`.
 *
 * That is Devin's layout (D4 §1.2: one summary file per session +
 * `summaryState/<id>` holding the message cursor and the summariser session id)
 * with our own substrate; the renderer never touches the file system or a
 * process. Spawning happens here so the sessions all live under one folder
 * (`space-summarizer/`) instead of mixing into the user's projects.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isTrustedSender } from "./lib/self-update-logic.mjs";
import { isLoopbackAppUrl } from "./lib/window-url-policy.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  SETTINGS_FILE,
  SUMMARY_DIR,
  SUMMARIZER_CWD,
  buildClaudeArgs,
  buildSummaryPrompt,
  formatTranscript,
  isSafeSummaryKey,
  mergeSummarySettings,
  normalizeTranscriptMessages,
  parseClaudeResult,
  parseSummaryIndex,
  publicSummarySettings,
  resolveClaudeCommand,
  resolveSummarySettings,
  summaryModeFor,
  upsertSummaryEntry,
} from "./lib/space-summary-logic.mjs";

const CHANNEL = {
  summarize: "space-summary:summarize",
  read: "space-summary:read",
  list: "space-summary:list",
  settings: "space-summary:settings",
  setSettings: "space-summary:set-settings",
};

function readJson(file) {
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    return {};
  }
}

/**
 * One `claude -p` call: prompt on stdin (a transcript is far too big for argv),
 * JSON on stdout, hard timeout.
 */
function runClaude({ command, args, cwd, prompt, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE is set by our own build/dev scripts; leaking it to a
    // child can make a Node-based CLI run as a bare interpreter instead of itself.
    const childEnv = { ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`The summariser timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf8");
      if (code !== 0 && !text.trim()) {
        reject(
          new Error(
            `claude exited ${code}: ${Buffer.concat(stderr)
              .toString("utf8")
              .slice(0, 300)
              .trim()}`,
          ),
        );
        return;
      }
      try {
        resolve(parseClaudeResult(text));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.on("error", () => {}); // EPIPE when the CLI dies early: the close handler reports it
    child.stdin.end(prompt);
  });
}

/**
 * @param {{
 *   app: import("electron").App,
 *   ipcMain: typeof import("electron").ipcMain,
 *   getMainWindow: () => import("electron").BrowserWindow | null,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 * }} deps
 */
export function registerSpaceSummary({
  app,
  ipcMain,
  getMainWindow,
  env,
  platform = process.platform,
}) {
  const environment = env ?? process.env;
  const summaryDir = join(app.getPath("userData"), SUMMARY_DIR);
  const summarizerCwd = join(app.getPath("userData"), SUMMARIZER_CWD);
  const settingsFile = join(app.getPath("userData"), SETTINGS_FILE);
  const indexFile = join(summaryDir, "index.json");
  const summaryFile = (conversationId) =>
    join(summaryDir, `${conversationId}.md`);

  const readIndex = () =>
    parseSummaryIndex(
      existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "",
    );

  /**
   * index.json read-modify-write, one at a time (reports/R4.md S3). A digest run
   * takes up to two minutes, so two refreshes overlap by design, and each of them
   * rewrites the WHOLE file: writing the copy it read at the start drops the
   * other one's entry — and a missing entry loses its claudeSessionId, so the
   * next refresh re-summarises that conversation from scratch.
   */
  let indexWrites = Promise.resolve();
  const updateIndex = (mutate) => {
    const step = () => {
      const next = mutate(readIndex());
      writeFileSync(indexFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return next;
    };
    // Chained on both branches: a failed digest must not poison later writes.
    indexWrites = indexWrites.then(step, step);
    return indexWrites;
  };

  /**
   * One digest per conversation at a time (a second request joins the running
   * one) and at most this many `claude -p` processes at once: a space with N
   * members used to start N Opus runs in parallel.
   */
  const MAX_CONCURRENT_DIGESTS = 2;
  const digestInFlight = new Map();
  const digestQueue = [];
  let activeDigests = 0;

  const pumpDigestQueue = () => {
    while (activeDigests < MAX_CONCURRENT_DIGESTS && digestQueue.length > 0) {
      const { run, settle } = digestQueue.shift();
      activeDigests += 1;
      run().then(
        (value) => settle({ ok: true, value }),
        (error) => settle({ ok: false, error }),
      );
    }
  };

  const withDigestSlot = (run) =>
    new Promise((resolve, reject) => {
      digestQueue.push({
        run,
        settle: (outcome) => {
          activeDigests -= 1;
          pumpDigestQueue();
          if (outcome.ok) resolve(outcome.value);
          else reject(outcome.error);
        },
      });
      pumpDigestQueue();
    });

  const settings = () =>
    resolveSummarySettings({
      stored: readJson(settingsFile),
      env: environment,
    });

  const trusted = (event) => {
    const win = getMainWindow();
    return isTrustedSender({
      senderIsMainWindow: Boolean(
        win && !win.isDestroyed() && event.sender === win.webContents,
      ),
      senderIsMainFrame: event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url,
      isLoopbackAppUrl,
    });
  };

  /** Wrap a handler: reject untrusted senders, never throw to the renderer. */
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) return { ok: false, error: "untrusted sender" };
      try {
        return await fn(...args);
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    });
  };

  const summarize = async (request) => {
    // The channel wrapper has already checked the id and taken the slot.
    const conversationId = request?.conversationId;
    const current = settings();
    if (!current.enabled) {
      return { ok: false, disabled: true, error: "Space summaries are off." };
    }

    mkdirSync(summarizerCwd, { recursive: true });
    mkdirSync(summaryDir, { recursive: true });

    const index = readIndex();
    const messages = normalizeTranscriptMessages(request?.messages);
    if (messages.length === 0) {
      throw new Error(
        "Nothing to summarize: the conversation has no messages yet.",
      );
    }

    // The index is the only cursor: the renderer's copy is a display cache, so a
    // cleared localStorage cannot make a digest skip messages.
    const mode = summaryModeFor(index, conversationId);
    const since =
      mode === "incremental"
        ? Math.min(index[conversationId].messageCount, messages.length)
        : 0;
    if (since >= messages.length) {
      const file = summaryFile(conversationId);
      return {
        ok: true,
        unchanged: true,
        messageCount: since,
        summary: existsSync(file) ? readFileSync(file, "utf8") : "",
      };
    }

    const command = resolveClaudeCommand({
      settings: current,
      env: environment,
      // Without this the resolver defaults to win32: it splits a POSIX PATH on
      // ';' (one bogus directory) and probes the %APPDATA% npm layout, so on
      // macOS/Linux no Claude Code is ever found (reports/R4.md M4).
      platform,
      exists: (candidate) => existsSync(candidate),
    });
    if (!command.command) {
      throw new Error(
        "Claude Code was not found on PATH, so a space cannot be summarized. Install `claude` or set its path in space-summary.json.",
      );
    }
    if (command.needsShell) {
      // Spawning a .cmd shim needs a shell, which would mean building a command
      // line out of our arguments. Not worth the injection surface: point at
      // the native binary instead.
      throw new Error(
        `Found only the ${command.command} shim, which cannot be spawned safely. Install the native claude.exe or set its path in space-summary.json.`,
      );
    }

    const incremental = mode === "incremental";
    const result = await runClaude({
      command: command.command,
      args: buildClaudeArgs({
        settings: current,
        sessionId: incremental ? index[conversationId].claudeSessionId : "",
      }),
      cwd: summarizerCwd,
      prompt: buildSummaryPrompt({
        transcript: formatTranscript(messages.slice(since), since),
        incremental,
      }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      env: environment,
    });

    writeFileSync(summaryFile(conversationId), result.summary, "utf8");
    // Read-modify-write inside the writer chain: the copy this call read at the
    // start is two minutes stale by now.
    const next = await updateIndex((stored) =>
      upsertSummaryEntry(stored, conversationId, {
        messageCount: messages.length,
        claudeSessionId: result.sessionId,
        updatedMs: Date.now(),
      }),
    );

    return {
      ok: true,
      summary: result.summary,
      messageCount: next[conversationId].messageCount,
      incremental,
      updatedAt: new Date(next[conversationId].updatedMs).toISOString(),
    };
  };

  handle(CHANNEL.summarize, (request) => {
    const conversationId = request?.conversationId;
    if (!isSafeSummaryKey(conversationId)) {
      throw new Error("Cannot summarize a conversation without an id.");
    }
    const running = digestInFlight.get(conversationId);
    if (running) return running;
    const run = withDigestSlot(() => summarize(request)).finally(() =>
      digestInFlight.delete(conversationId),
    );
    digestInFlight.set(conversationId, run);
    return run;
  });

  handle(CHANNEL.read, async ({ conversationId } = {}) => {
    if (!isSafeSummaryKey(conversationId))
      return { ok: false, error: "bad id" };
    const file = summaryFile(conversationId);
    if (!existsSync(file)) return { ok: false, error: "no summary" };
    return { ok: true, summary: readFileSync(file, "utf8") };
  });

  /** Everything on disk, so the renderer can hydrate in one call at startup. */
  handle(CHANNEL.list, async () => {
    const index = parseSummaryIndex(
      existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "",
    );
    const summaries = {};
    for (const [conversationId, entry] of Object.entries(index)) {
      const file = summaryFile(conversationId);
      if (!existsSync(file)) continue; // Devin keeps the mapping and the file; a stale entry is not a summary
      summaries[conversationId] = {
        summary: readFileSync(file, "utf8"),
        messageCount: entry.messageCount,
        updatedAt: new Date(entry.updatedMs || Date.now()).toISOString(),
      };
    }
    return { ok: true, summaries };
  });

  handle(CHANNEL.settings, async () => ({
    ok: true,
    settings: publicSummarySettings(settings()),
  }));

  handle(CHANNEL.setSettings, async (patch) => {
    writeFileSync(
      settingsFile,
      `${JSON.stringify(mergeSummarySettings(readJson(settingsFile), patch), null, 2)}\n`,
      "utf8",
    );
    return { ok: true, settings: publicSummarySettings(settings()) };
  });

  return { CHANNEL };
}
