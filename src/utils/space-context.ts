/**
 * The block a new conversation in a space starts with — Devin's
 * `<project_context>` text builder (`e3A` in the Devin bundle, reports/D4.md
 * §1.4) reproduced verbatim, plus the size caps Devin itself does not have
 * (D4 §4.1 risk (a)).
 *
 * It is sent as its own text part in front of the user's first message
 * (`src/hooks/use-send-message.ts`), which is the faithful equivalent of
 * Devin's hidden prompt resource: any agent, OpenHands or ACP, receives text
 * parts verbatim.
 */

/** Devin's intro sentence, verbatim. */
export const SPACE_CONTEXT_INTRO =
  'The following are summaries of other sessions in this project. Each <session> block has a "title" attribute (the session\'s name) and contains a <summary> of the work done in that session. Use this as background context — it is not necessarily related to your current task.';

/** ~4k tokens at the usual ~4 characters per token. */
export const SPACE_SUMMARY_CHAR_LIMIT = 16_000;

/** ~40k tokens for the whole block; the budget Devin happily blows up on. */
export const SPACE_CONTEXT_CHAR_LIMIT = 160_000;

/** Marker appended to a digest that was cut to {@link SPACE_SUMMARY_CHAR_LIMIT}. */
export const SUMMARY_TRUNCATED_LINE = "\n[... summary truncated ...]";

export interface SpaceContextSession {
  /** Conversation title, used for the `title` attribute. */
  title: string;
  /** Its digest, or null/empty when it has none yet (renders as a self-closing tag). */
  summary?: string | null;
}

export interface SpaceContextBlock {
  text: string;
  /** Whole digests dropped to `<session title="…" />` to stay in budget. */
  droppedSummaryCount: number;
  /** Members dropped entirely (their empty tag was still over budget). */
  droppedSessionCount: number;
}

/** XML-escape an attribute/text value (Devin's `escapeXml`). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * XML-escape text content: `&`, `<` and `>` only, because a text node needs no
 * quote escaping and a digest is prose (quotes must stay readable).
 */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Our own envelope, and only ours: the `name="` attribute is something
 * {@link buildSpaceContextBlock} always emits, so a user who merely types
 * `<project_context>` in their message is not mistaken for the block.
 */
const SPACE_CONTEXT_PART =
  /<project_context name="[\s\S]*?<\/project_context>\n*/g;

/**
 * The block with every space envelope removed, leaving the user's own text.
 * The held-message comparison needs this (`hasSendingBubble` in
 * `src/contexts/conversation-websocket-context.tsx`): the optimistic bubble
 * holds the user text only, while the sent message has the block in front of it.
 */
export function stripSpaceContextParts(text: string): string {
  return text.replace(SPACE_CONTEXT_PART, "");
}

/** Whether a message carries the space block (used to mark it injected on delivery). */
export function hasSpaceContextParts(text: string): boolean {
  return /<project_context name="/.test(text);
}

export function truncateSummary(
  summary: string,
  limit = SPACE_SUMMARY_CHAR_LIMIT,
): string {
  const trimmed = summary.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit).trimEnd() + SUMMARY_TRUNCATED_LINE;
}

function sessionBlock(session: SpaceContextSession): string {
  const title = escapeXml(session.title);
  // Escaped as well as the title: a digest is model output over an untrusted
  // transcript, and an unescaped `</project_context>` in it would close the
  // envelope inside every OTHER member's first message (cross-conversation
  // prompt injection with this app's own credibility).
  const summary = escapeXmlText(truncateSummary(session.summary ?? ""));
  return summary
    ? `<session title="${title}">\n${summary}\n</session>`
    : `<session title="${title}" />`;
}

/**
 * Builds Devin's block for `sessions` (the space's members, current
 * conversation already excluded, oldest first). When the whole block is over
 * budget, the oldest digests are dropped to empty `<session title="…" />` tags
 * — the agent still learns the shape of the group — and if even that is over
 * budget, the oldest sessions are dropped whole. The result is never over
 * budget: when only the envelope itself is left and that still does not fit,
 * the block is empty and the caller sends no context at all.
 */
export function buildSpaceContextBlock(
  spaceTitle: string,
  sessions: SpaceContextSession[],
  limit = SPACE_CONTEXT_CHAR_LIMIT,
): SpaceContextBlock {
  const blocks = sessions.map(sessionBlock);
  const wrap = (parts: string[]) =>
    `<project_context name="${escapeXml(spaceTitle)}">\n${SPACE_CONTEXT_INTRO}\n\n${parts.join(
      "\n\n",
    )}\n</project_context>\n\n`;

  let droppedSummaryCount = 0;
  let droppedSessionCount = 0;

  // Phase 1: the oldest digests become empty tags, oldest first.
  for (let index = 0; index < blocks.length; index += 1) {
    if (wrap(blocks).length <= limit) break;
    const empty = sessionBlock({ title: sessions[index].title });
    if (blocks[index] === empty) continue; // no digest to drop here
    blocks[index] = empty;
    droppedSummaryCount += 1;
  }
  // Phase 2: whole members go, oldest first. A budget that can still be blown
  // is not a budget.
  while (blocks.length > 0 && wrap(blocks).length > limit) {
    blocks.shift();
    droppedSessionCount += 1;
  }

  const text = wrap(blocks);
  return {
    // Not even the envelope fits: send no context rather than an over-budget one.
    text: text.length > limit ? "" : text,
    droppedSummaryCount,
    droppedSessionCount,
  };
}
