/**
 * Pure logic behind the Spaces summariser (fork feature): the settings, Devin's
 * prompt pair, the `claude -p` command line and the summary index. Kept free of
 * Electron and of child_process so it is unit-testable
 * (`space-summary-logic.test.mjs`).
 *
 * The summariser is Claude Code running headless on the user's existing login
 * (no API key field anywhere): one `claude -p` call per conversation, continued
 * with `--resume <session_id>` on refresh — the Canvas equivalent of Devin's
 * per-conversation `summary-agent` session (reports/D4.md §1.2).
 */

import { join } from "node:path";

/** Latest Opus, the way the CLI resolves it. Settings may name any model. */
export const DEFAULT_MODEL = "opus";
export const SETTINGS_FILE = "space-summary.json";
/** Folder under userData that holds the digests and the index. */
export const SUMMARY_DIR = "space_summaries";
/** Folder under userData these sessions are spawned from, so they group together. */
export const SUMMARIZER_CWD = "space-summarizer";
/** One digest should never be longer than this (~4k tokens). */
export const MAX_SUMMARY_TOKENS = 4096;
/** A summariser call that outlives this is killed: a space never blocks a send. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Devin's own transcript cap (`e3e` in its bundle): 200,000 characters. */
export const TRANSCRIPT_CHAR_LIMIT = 200_000;
/** Keeps a runaway IPC payload from turning into a 50 MB argv-less prompt. */
export const MAX_TRANSCRIPT_MESSAGES = 20_000;

/** Devin's omission line, verbatim (`e3i` in the Devin bundle). */
export function omittedMessagesLine(count) {
  return `[... ${count} messages omitted due to length ...]`;
}

/** Only used when a single message is bigger than the whole budget. */
export const TRUNCATED_TEXT_LINE =
  "[... message text truncated due to length ...]";

/**
 * Devin's transcript text (`e3i`): `=== MESSAGE n - User ===` blocks, numbered
 * from `startIndex + 1` so an incremental prompt continues the numbering of the
 * messages it skips, capped at `limit` characters with Devin's head-half /
 * tail-quarter truncation.
 */
export function formatTranscript(
  messages,
  startIndex = 0,
  limit = TRANSCRIPT_CHAR_LIMIT,
) {
  const entries = messages.map(
    (message, index) =>
      `=== MESSAGE ${startIndex + index + 1} - ${message.role} ===\n${message.text}`,
  );
  const joined = entries.join("\n");
  if (entries.length === 0 || joined.length <= limit) return joined;

  const headBudget = Math.floor(limit / 2);
  const tailBudget = Math.floor(limit / 4);

  let headCount = 0;
  let headLength = 0;
  while (
    headCount < entries.length &&
    headLength + entries[headCount].length + 1 <= headBudget
  ) {
    headLength += entries[headCount].length + 1;
    headCount += 1;
  }

  let tailCount = 0;
  let tailLength = 0;
  while (
    tailCount < entries.length - headCount &&
    tailLength + entries[entries.length - 1 - tailCount].length + 1 <=
      tailBudget
  ) {
    tailLength += entries[entries.length - 1 - tailCount].length + 1;
    tailCount += 1;
  }

  const omitted = entries.length - headCount - tailCount;
  if (omitted <= 0 || headCount === 0) {
    // No whole message fits the head budget (one giant message, or a budget
    // smaller than any message): cut the text itself rather than ship a
    // transcript that says only "everything was omitted".
    return [
      joined.slice(0, headBudget),
      TRUNCATED_TEXT_LINE,
      joined.slice(-tailBudget),
    ].join("\n");
  }

  return [
    ...entries.slice(0, headCount),
    omittedMessagesLine(omitted),
    ...entries.slice(entries.length - tailCount),
  ].join("\n");
}

/**
 * The renderer sends the conversation's user/assistant messages; anything else
 * is dropped rather than trusted (it arrives over IPC).
 */
export function normalizeTranscriptMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const clean = [];
  for (const message of messages.slice(0, MAX_TRANSCRIPT_MESSAGES)) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "User" && message.role !== "Assistant") continue;
    if (typeof message.text !== "string" || message.text.trim() === "")
      continue;
    clean.push({ role: message.role, text: message.text });
  }
  return clean;
}

/**
 * Devin's Summarizer persona (`chisel-server/src/agents/summarizer.rs`) with the
 * summary structure it writes (D4 §1.2). The labels are verbatim; the middle is
 * the structure the measured summary files have.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  "You are a Summarizer that summarizes conversation history.",
  "You have no tools. Your text output will be saved to a file automatically.",
  "Structure your summary as follows:",
  "<summary>",
  "",
  "## Overview",
  "<what this conversation was about and what was accomplished>",
  "",
  "## Key Details & Breadcrumbs",
  "- **bold lead**: sentence",
  "",
  "## Current State",
  "- bullet",
  "",
  "</summary>",
].join("\n");

/** First digest of a conversation, verbatim from Devin. */
export const FIRST_SUMMARY_PROMPT_PREFIX =
  "Output a summary from the following messages:\n\n";

/** Incremental refresh (only the messages after the stored cursor), verbatim. */
export const INCREMENTAL_SUMMARY_PROMPT_PREFIX =
  "Output a new summary with the following new messages from the same conversation:\n\n";

/** A conversation id becomes a file name: no separators, no `..` (Devin's own test). */
export function isSafeSummaryKey(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    // `:` is rejected too: on Windows `a:b` addresses another file's stream.
    value.length <= 128 &&
    !/<unknown>|[/\\]|\.\.|:/.test(value)
  );
}

function configured(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/**
 * Settings in precedence order: the settings file, then the environment, then
 * the defaults. There is deliberately no key field — auth is the user's own
 * Claude Code login.
 */
export function resolveSummarySettings({ stored, env } = {}) {
  const fromFile = stored && typeof stored === "object" ? stored : {};
  const fromEnv = env && typeof env === "object" ? env : {};
  const enabled =
    typeof fromFile.enabled === "boolean"
      ? fromFile.enabled
      : configured(fromEnv.AGENT_CANVAS_SPACE_SUMMARIZER) !== "off";
  // A model reaches argv, so an unusable value falls through the chain instead
  // of being passed to the CLI (see buildClaudeArgs for the same guard).
  const modelCandidates = [
    configured(fromFile.model),
    configured(fromEnv.AGENT_CANVAS_SPACE_SUMMARY_MODEL),
  ];
  return {
    model:
      modelCandidates.find((candidate) => isSafeModelName(candidate)) ||
      DEFAULT_MODEL,
    enabled,
    /** Optional explicit path to the CLI, for a claude that is not on PATH. */
    command:
      configured(fromFile.command) ||
      configured(fromEnv.AGENT_CANVAS_CLAUDE_COMMAND) ||
      "",
  };
}

/** What the renderer is allowed to see (and the settings card to show). */
export function publicSummarySettings(settings) {
  return { model: settings.model, enabled: settings.enabled };
}

/** Only these two knobs are settable from the app; anything else is ignored. */
export function mergeSummarySettings(stored, patch) {
  const base = stored && typeof stored === "object" ? stored : {};
  const next = { ...base };
  if (patch && typeof patch.model === "string" && patch.model.trim()) {
    next.model = patch.model.trim();
  }
  if (patch && typeof patch.enabled === "boolean") {
    next.enabled = patch.enabled;
  }
  return next;
}

/**
 * Where the Claude Code CLI is. Prefers a real executable: on Windows npm ships a
 * `claude.cmd` shim we refuse to spawn through a shell (see the caller), so the
 * native binary inside the npm package is tried as well.
 *
 * `exists` is injected so this stays unit-testable without touching a disk.
 */
export function resolveClaudeCommand({
  settings,
  env = {},
  platform = "win32",
  exists = () => false,
} = {}) {
  const explicit = configured(settings?.command);
  if (explicit) {
    return { command: explicit, needsShell: /\.(cmd|bat)$/i.test(explicit) };
  }
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const dirs = String(env[pathKey] ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  if (platform === "win32") {
    const appData = configured(env.APPDATA);
    if (appData) {
      dirs.push(
        join(
          appData,
          "npm",
          "node_modules",
          "@anthropic",
          "claude-code",
          "bin",
        ),
      );
      dirs.push(
        join(
          appData,
          "npm",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "bin",
        ),
      );
    }
  }
  const names =
    platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
      : ["claude"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) {
        return {
          command: candidate,
          needsShell: /\.(cmd|bat)$/i.test(candidate),
        };
      }
    }
  }
  return { command: "", needsShell: false };
}

export function buildSummaryPrompt({ transcript, incremental }) {
  const prefix = incremental
    ? INCREMENTAL_SUMMARY_PROMPT_PREFIX
    : FIRST_SUMMARY_PROMPT_PREFIX;
  return `${prefix}${transcript}`;
}

/**
 * A model id safe to put in argv; anything else falls back to the default.
 * The first character may not be `-`: otherwise a stored value like
 * `--dangerously-skip-permissions` would reach the CLI as a flag.
 */
export function isSafeModelName(value) {
  return (
    typeof value === "string" && /^[A-Za-z0-9.][\w.:@+/-]{0,99}$/.test(value)
  );
}

/** A session id we were handed back earlier, safe to put in argv. */
export function isSafeSessionId(value) {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
  );
}

/**
 * The command line for one digest call.
 *
 * Isolation, measured against `claude --help` 2.1.319 (and why each flag is
 * here):
 *  - `--tools ""` disables every tool: the summariser must not act;
 *  - `--strict-mcp-config` with no `--mcp-config` loads zero MCP servers;
 *  - `--setting-sources ""` loads no user/project/local settings, so the user's
 *    hooks and CLAUDE.md never run for a background digest;
 *  - `--bare` is deliberately NOT used: it refuses OAuth/keychain auth, which
 *    would break exactly the login this feature relies on;
 *  - the transcript goes on stdin (it can be ~200k characters, far too big for
 *    argv, and argv would leak it into the process list).
 */
export function buildClaudeArgs({ settings, sessionId }) {
  const model = isSafeModelName(settings?.model)
    ? settings.model
    : DEFAULT_MODEL;
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--system-prompt",
    SUMMARY_SYSTEM_PROMPT,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
  ];
  if (isSafeSessionId(sessionId)) {
    args.push("--resume", sessionId);
  }
  return args;
}

/**
 * Pull `result` + `session_id` out of the CLI's JSON envelope.
 * `--output-format json` prints exactly one object; anything else is a failure
 * the caller turns into "no summary for that member".
 */
export function parseClaudeResult(stdout) {
  let payload;
  try {
    payload = JSON.parse(String(stdout).trim());
  } catch {
    throw new Error("The summariser printed something that is not JSON.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("The summariser printed something that is not JSON.");
  }
  if (payload.is_error || payload.subtype === "error_during_execution") {
    throw new Error(
      `The summariser failed (${payload.subtype ?? "error"}${
        payload.api_error_status ? `: ${payload.api_error_status}` : ""
      }).`,
    );
  }
  const summary =
    typeof payload.result === "string" ? payload.result.trim() : "";
  if (!summary) {
    throw new Error("The summariser returned no text.");
  }
  const sessionId = isSafeSessionId(payload.session_id)
    ? payload.session_id
    : "";
  return { summary, sessionId };
}

/** The index next to the digest files: `{ [conversationId]: entry }`. */
export function parseSummaryIndex(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || "{}"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const index = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (!isSafeSummaryKey(key) || !entry || typeof entry !== "object") continue;
    const messageCount = Number(entry.messageCount);
    if (!Number.isFinite(messageCount) || messageCount < 0) continue;
    index[key] = {
      messageCount: Math.floor(messageCount),
      claudeSessionId: isSafeSessionId(entry.claudeSessionId)
        ? entry.claudeSessionId
        : "",
      updatedMs: Number.isFinite(Number(entry.updatedMs))
        ? Number(entry.updatedMs)
        : 0,
    };
  }
  return index;
}

/**
 * Devin's `{messageCount, summariser session id}` per conversation, after a
 * digest was written. Without a session id the previous one is kept, so a
 * transient JSON that omits it cannot break the continuation chain.
 */
export function upsertSummaryEntry(
  index,
  conversationId,
  { messageCount, claudeSessionId, updatedMs },
) {
  if (!isSafeSummaryKey(conversationId)) return index;
  const previous = index[conversationId];
  const count = Number(messageCount);
  return {
    ...index,
    [conversationId]: {
      messageCount:
        Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
      claudeSessionId: isSafeSessionId(claudeSessionId)
        ? claudeSessionId
        : (previous?.claudeSessionId ?? ""),
      updatedMs: Number.isFinite(Number(updatedMs))
        ? Number(updatedMs)
        : Date.now(),
    },
  };
}

/**
 * Which prompt this conversation needs: a refresh only continues the same
 * session when we have both the cursor and a session to continue.
 */
export function summaryModeFor(index, conversationId) {
  const entry = index[conversationId];
  return entry?.claudeSessionId && entry.messageCount > 0
    ? "incremental"
    : "initial";
}
