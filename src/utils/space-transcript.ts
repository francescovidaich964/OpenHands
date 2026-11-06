import type { OpenHandsEvent } from "#/types/agent-server/core";
import type { Message } from "#/types/agent-server/core/base/event";
import { isMessageEvent } from "#/types/agent-server/type-guards";

/**
 * The user/assistant messages of a conversation, in the shape the Spaces
 * summariser takes. Tool calls and thoughts are skipped, like Devin's formatter
 * skips `Tool` / `AssistantThought` (reports/D4.md §1.2); the transcript text
 * itself (`=== MESSAGE n - User ===`, the 200,000-character head+tail cap) is
 * built by the main process — see `electron/lib/space-summary-logic.mjs` —
 * because that is also where the incremental cursor lives.
 */
export interface TranscriptMessage {
  /** Devin's labels: `User` | `Assistant`. */
  role: "User" | "Assistant";
  text: string;
}

function textContentOf(message: Message): string {
  // The SDK types `content` as an array of parts; a bare string is tolerated
  // because that is what some events (and most fixtures) carry.
  const content = message.content as Message["content"] | string;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function transcriptMessagesFromEvents(
  events: OpenHandsEvent[],
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const event of events) {
    if (!isMessageEvent(event)) continue;
    const role = event.llm_message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textContentOf(event.llm_message);
    if (!text) continue;
    messages.push({ role: role === "user" ? "User" : "Assistant", text });
  }
  return messages;
}

/** Devin's transcript cap again (`TRANSCRIPT_CHAR_LIMIT` in the main process). */
export const RENDERER_TRANSCRIPT_CHAR_LIMIT = 200_000;

/**
 * Placeholder text for a message whose body the cap dropped. It stays non-empty
 * on purpose: the main process stores `messages.length` as its incremental
 * cursor, so the COUNT of this list is part of the contract and a dropped
 * message would make every later digest slice the transcript at the wrong place.
 */
const OMITTED_MESSAGE_TEXT = "[]";

/**
 * Bounds what goes over IPC (reports/R4.md NIT): without it a space of ten long
 * conversations materialises ten full transcripts in the renderer and ships them
 * all to the main process, which then cuts them to 200k characters anyway.
 *
 * Devin's proportions, applied to the messages instead of the joined text: the
 * head half of the budget and the tail quarter stay whole, the middle becomes
 * placeholders. The main process still owns the real formatting and the real cap;
 * this only stops the renderer from sending a payload nobody can read.
 */
export function capTranscriptMessages(
  messages: TranscriptMessage[],
  limit = RENDERER_TRANSCRIPT_CHAR_LIMIT,
): TranscriptMessage[] {
  const total = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (total <= limit) return messages;

  const capped = [...messages];
  let headUsed = 0;
  let index = 0;
  while (
    index < capped.length &&
    headUsed + capped[index].text.length + 1 <= Math.floor(limit / 2)
  ) {
    headUsed += capped[index].text.length + 1;
    index += 1;
  }

  let tailUsed = 0;
  let last = capped.length - 1;
  while (
    last > index &&
    tailUsed + capped[last].text.length + 1 <= Math.floor(limit / 4)
  ) {
    tailUsed += capped[last].text.length + 1;
    last -= 1;
  }

  for (let middle = index; middle <= last; middle += 1) {
    capped[middle] = { role: capped[middle].role, text: OMITTED_MESSAGE_TEXT };
  }
  return capped;
}
