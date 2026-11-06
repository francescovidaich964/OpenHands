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
  const summary = truncateSummary(session.summary ?? "");
  return summary
    ? `<session title="${title}">\n${summary}\n</session>`
    : `<session title="${title}" />`;
}

/**
 * Builds Devin's block for `sessions` (the space's members, current
 * conversation already excluded, oldest first). When the whole block is over
 * budget, the oldest digests are dropped to empty `<session title="…" />` tags
 * — the agent still learns the shape of the group.
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
  for (let index = 0; index < blocks.length; index += 1) {
    if (wrap(blocks).length <= limit) break;
    if (blocks[index] === sessionBlock({ title: sessions[index].title })) {
      continue; // already empty — nothing left to drop here
    }
    blocks[index] = sessionBlock({ title: sessions[index].title });
    droppedSummaryCount += 1;
  }

  return { text: wrap(blocks), droppedSummaryCount };
}
