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
