import { BUILT_IN_COMMANDS } from "#/utils/constants";
import type { MessageEvent } from "#/types/agent-server/core";
/**
 * Wire-format tokens for the reply-quote envelope. These are program
 * identifiers — named constants per spec (docs/specs/reply-message.md) — and
 * are locale-independent. They are NOT i18n keys.
 */
export const REPLY_OPEN_TAG = "<reply-to";
export const REPLY_CLOSE_TAG = "</reply-to>";

/**
 * Soft cap on the quoted body, per spec assumption 4.
 */
const MAX_QUOTE_BODY = 2000;

/**
 * True when the typed follow-up is itself a built-in slash command
 * (`/new`, `/model <…>`, `/goal <…>`, …). Slash commands are intercepted
 * downstream and never reach the agent as text, so the submission path must
 * not wrap them in a reply-quote envelope (a composed envelope would break
 * the exact/prefix command match and leak the envelope to the agent).
 */
export const isBuiltInSlashCommand = (followUp: string): boolean => {
  const firstLine = followUp.trimStart().split("\n", 1)[0].trimEnd();
  return BUILT_IN_COMMANDS.some(
    (cmd) =>
      firstLine === cmd.command || firstLine.startsWith(`${cmd.command} `),
  );
};

export interface ReplyQuote {
  sourceEventId: string;
  source: "user" | "agent";
  /** Quoted text actually stored (post-truncation, inner envelopes stripped). */
  body: string;
  truncated: boolean;
}

const parseOpenTag = (openTag: string): ReplyQuote | null => {
  // Shape: <reply-to id="..." source="user|agent" truncated="true|false">
  const m = openTag.match(
    /^<reply-to\s+id="([^"]*)"\s+source="(user|agent)"\s+truncated="(true|false)">$/,
  );
  if (!m) return null;

  return {
    sourceEventId: m[1],
    source: m[2] as ReplyQuote["source"],
    body: "",
    truncated: m[3] === "true",
  };
};

/**
 * Composes the outgoing user message text: envelope at position 0, followed
 * by the typed follow-up. Null quote → follow-up unchanged. Idempotent: a
 * follow-up already starting with the opening-tag token is returned untouched.
 */
export const composeReplyText = (
  quote: ReplyQuote | null,
  followUp: string,
): string => {
  if (!quote) return followUp;

  if (followUp.trimStart().startsWith(REPLY_OPEN_TAG)) {
    return followUp;
  }

  // Depth-1 guarantee (spec assumption 2): never store an inner envelope in
  // the quoted body — quote only the visible follow-up text. One split pass
  // suffices: an envelope-shaped body re-parses to quote + follow-up.
  const parsedBody = splitReplyFromText(quote.body);
  const bodyText = parsedBody.quote ? parsedBody.body : quote.body;
  const truncated = quote.truncated || bodyText.length > MAX_QUOTE_BODY;

  const openTag = `${REPLY_OPEN_TAG} id="${quote.sourceEventId}" source="${quote.source}" truncated="${truncated}">`;
  const envelope = `${openTag}${bodyText}${REPLY_CLOSE_TAG}`;
  const trimmedFollowUp = followUp.trimStart();

  return trimmedFollowUp ? envelope + trimmedFollowUp : envelope;
};

/**
 * Splits a message text into its leading reply-quote envelope (if any) and
 * the remaining follow-up body. Anchored at position 0 — the same convention
 * as `splitInlineThink` — so envelopes appearing mid-text stay verbatim.
 * A malformed or unclosed envelope degrades to plain text, never a crash.
 */
export const splitReplyFromText = (
  text: string,
): {
  quote: ReplyQuote | null;
  body: string;
} => {
  if (!text.startsWith(REPLY_OPEN_TAG)) {
    return { quote: null, body: text };
  }

  const openTagEnd = text.indexOf(">");
  if (openTagEnd === -1) {
    return { quote: null, body: text };
  }

  const parsedOpen = parseOpenTag(text.slice(0, openTagEnd + 1));
  if (!parsedOpen) {
    return { quote: null, body: text };
  }

  // The quoted body may itself contain a complete inner envelope, so the
  // tag that closes THIS envelope is not necessarily the first close tag.
  // Scan forward tracking envelope depth. Fully model-controlled text can
  // bury a ladder of open tags, and depth beyond one inner layer has no
  // legitimate meaning (spec assumption 2: depth-1 format), so exceeding
  // the cap degrades the whole envelope to plain text — bounded, the same
  // philosophy as the jump hook's page guard.
  const MAX_ENVELOPE_DEPTH = 2;
  let depth = 1;
  let cursor = openTagEnd + 1;
  let closeIndex = -1;
  while (cursor < text.length) {
    const nextOpen = text.indexOf(REPLY_OPEN_TAG, cursor);
    const nextClose = text.indexOf(REPLY_CLOSE_TAG, cursor);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      if (depth >= MAX_ENVELOPE_DEPTH) {
        return { quote: null, body: text };
      }
      depth += 1;
      cursor = nextOpen + REPLY_OPEN_TAG.length;
    } else {
      depth -= 1;
      cursor = nextClose + REPLY_CLOSE_TAG.length;
      if (depth === 0) {
        closeIndex = nextClose;
        break;
      }
    }
  }
  if (closeIndex === -1) {
    return { quote: null, body: text };
  }

  const quote: ReplyQuote = {
    ...parsedOpen,
    body: text.slice(openTagEnd + 1, closeIndex),
  };

  return { quote, body: text.slice(closeIndex + REPLY_CLOSE_TAG.length) };
};

/**
 * Strips every complete `<reply-to>…</reply-to>` envelope from a text.
 * A malformed (unclosed) inner envelope is kept verbatim.
 */
const stripReplyEnvelopes = (text: string): string => {
  let result = "";
  let rest = text;

  for (;;) {
    const openIdx = rest.indexOf(REPLY_OPEN_TAG);
    if (openIdx === -1) {
      result += rest;
      return result;
    }

    const closeIdx = rest.indexOf(REPLY_CLOSE_TAG, openIdx);
    if (closeIdx === -1) {
      result += rest;
      return result;
    }

    result += rest.slice(0, openIdx);
    rest = rest.slice(closeIdx + REPLY_CLOSE_TAG.length);
  }
};

/**
 * Derives the ReplyQuote for a given source event from its *displayed* text
 * (the same string the user sees — agent messages have already been through
 * `splitInlineThink`). Returns null for empty or image-only sources.
 * Truncates beyond the cap and strips inner envelopes so the format stays
 * depth-1.
 */
export const quoteBodyForEvent = (
  event: MessageEvent,
  fullText: string,
): ReplyQuote | null => {
  const trimmed = fullText.trim();
  if (!trimmed) return null;

  let body = fullText;
  const leading = body.replace(/^\s+/, "");
  if (leading.startsWith(REPLY_OPEN_TAG)) {
    // The source is itself a reply: quote only its visible follow-up.
    body = splitReplyFromText(body).body;
  }

  const stripped = stripReplyEnvelopes(body);
  const truncated = stripped.length > MAX_QUOTE_BODY;
  const finalBody = truncated ? stripped.slice(0, MAX_QUOTE_BODY) : stripped;

  return {
    sourceEventId: event.id,
    source: event.source === "user" ? "user" : "agent",
    body: finalBody,
    truncated,
  };
};

/* --------------------------------------------------------------------------
 * Passage quote ("comment on a selected passage").
 *
 * Same job as the `<reply-to>` envelope above, finer granularity: it carries a
 * *selection* out of one message. The envelope is a text part of its own on the
 * wire (never merged with the typed comment) and the comment is what the user
 * typed, so an agent sees "<the passage I mean> then <my comment>".
 * ------------------------------------------------------------------------ */

/** Program identifiers, not i18n keys — the wire format is locale-independent. */
export const QUOTE_OPEN_TAG = "<quoted_artifact";
export const QUOTE_CLOSE_TAG = "</quoted_artifact>";

/**
 * Soft cap on a selected passage. A passage is chosen by hand, so the cap only
 * catches select-all on a very long reply; `truncated` tells the card to say so.
 */
export const MAX_PASSAGE_BODY = 4000;

export interface PassageQuote {
  /** id of the message the passage was selected from. */
  eventId: string;
  author: "user" | "agent";
  /** What the user said about the passage; empty means a bare quote. */
  caption: string;
  /** The passage: markdown source lines when known, selection text otherwise. */
  content: string;
  /**
   * 1-based markdown source lines the passage spans inside the source message.
   * Optional: it lets clicking a card re-select the passage instead of falling
   * back to a text search. Devin's format has no locator, so a foreign
   * envelope without one still parses.
   */
  startLine?: number;
  endLine?: number;
  truncated: boolean;
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const unescapeXml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const attribute = (name: string, value: string): string =>
  ` ${name}="${escapeXml(value)}"`;

/**
 * Builds the wire envelope for a passage quote. Caption is omitted when empty.
 */
export const buildQuoteEnvelope = (quote: PassageQuote): string => {
  const content =
    quote.content.length > MAX_PASSAGE_BODY
      ? quote.content.slice(0, MAX_PASSAGE_BODY)
      : quote.content;
  const truncated = quote.truncated || content.length !== quote.content.length;

  let open = `${QUOTE_OPEN_TAG} kind="message"${attribute("event_id", quote.eventId)}${attribute("author", quote.author)}`;
  if (quote.startLine != null && quote.endLine != null) {
    open += ` start_line="${quote.startLine}" end_line="${quote.endLine}"`;
  }
  if (truncated) open += ' truncated="true"';
  open += ">";

  const caption = quote.caption.trim()
    ? `<caption>${escapeXml(quote.caption.trim())}</caption>\n`
    : "";

  return `${open}\n${caption}<content>\n${escapeXml(content)}\n</content>\n${QUOTE_CLOSE_TAG}`;
};

const QUOTE_ENVELOPE =
  /<quoted_artifact\b([^>]*)>\n(?:<caption>([\s\S]*?)<\/caption>\n)?<content>\n([\s\S]*?)\n<\/content>\n<\/quoted_artifact>/g;

const numberAttribute = (
  attributes: string,
  name: string,
): number | undefined => {
  const m = attributes.match(new RegExp(` ${name}="(\\d+)"`));
  return m ? Number(m[1]) : undefined;
};

const stringAttribute = (attributes: string, name: string): string => {
  const m = attributes.match(new RegExp(` ${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : "";
};

/**
 * Every passage envelope in a text, in order, plus the text with them removed.
 * A malformed or unclosed envelope is left in `rest` verbatim: unknown markup
 * must reach the screen rather than disappear with a half-parsed quote.
 */
export const splitQuoteEnvelopesFromText = (
  text: string,
): { quotes: PassageQuote[]; rest: string } => {
  const quotes: PassageQuote[] = [];
  // A fresh lastIndex each call: the regex is shared and stateful.
  QUOTE_ENVELOPE.lastIndex = 0;
  const rest = text.replace(
    QUOTE_ENVELOPE,
    (match, attrs: string, cap, body) => {
      const author = stringAttribute(attrs, "author");
      const eventId = stringAttribute(attrs, "event_id");
      if (!eventId) return match;
      quotes.push({
        eventId,
        author: author === "user" ? "user" : "agent",
        caption: cap == null ? "" : unescapeXml(cap),
        content: unescapeXml(body),
        startLine: numberAttribute(attrs, "start_line"),
        endLine: numberAttribute(attrs, "end_line"),
        truncated: / truncated="true"/.test(attrs),
      });
      return "";
    },
  );

  return { quotes, rest: rest.replace(/^\n+|\n+$/g, "") };
};

/** Display text for a message that carries passage envelopes (cards show the rest). */
export const stripQuoteEnvelopes = (text: string): string =>
  splitQuoteEnvelopesFromText(text).rest;

/** True when a message text carries at least one passage envelope. */
export const hasQuoteEnvelope = (text: string): boolean =>
  splitQuoteEnvelopesFromText(text).quotes.length > 0;
