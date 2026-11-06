import { describe, expect, it } from "vitest";

import {
  capTranscriptMessages,
  transcriptMessagesFromEvents,
} from "#/utils/space-transcript";
import type { OpenHandsEvent } from "#/types/agent-server/core";

const messageEvent = (kind: string, role: string, content: unknown) =>
  ({ kind, llm_message: { role, content } }) as unknown as OpenHandsEvent;

describe("transcriptMessagesFromEvents", () => {
  it("keeps the user and assistant turns in order", () => {
    expect(
      transcriptMessagesFromEvents([
        messageEvent("MessageEvent", "user", [{ type: "text", text: "do it" }]),
        messageEvent("MessageEvent", "assistant", "done"),
      ]),
    ).toEqual([
      { role: "User", text: "do it" },
      { role: "Assistant", text: "done" },
    ]);
  });

  it("joins the text parts of one message", () => {
    expect(
      transcriptMessagesFromEvents([
        messageEvent("MessageEvent", "user", [
          { type: "text", text: "line one" },
          { type: "image", image_url: { url: "x" } },
          { type: "text", text: "line two" },
        ]),
      ]),
    ).toEqual([{ role: "User", text: "line one\nline two" }]);
  });

  it("skips everything that is not a spoken turn", () => {
    expect(
      transcriptMessagesFromEvents([
        // the repo's guard is structural (`llm_message` with role+content), so
        // anything without that shape is not a turn
        { kind: "ObservationEvent" } as unknown as OpenHandsEvent,
        {
          kind: "ActionEvent",
          llm_message: { role: "assistant" },
        } as unknown as OpenHandsEvent,
        messageEvent("MessageEvent", "system", "instructions"),
        messageEvent("MessageEvent", "user", [{ type: "text", text: "   " }]),
        messageEvent("MessageEvent", "user", [{ type: "image" }]),
        messageEvent("MessageEvent", "user", null),
      ]),
    ).toEqual([]);
  });

  it("is empty for a conversation with no messages", () => {
    expect(transcriptMessagesFromEvents([])).toEqual([]);
  });
});

describe("capTranscriptMessages", () => {
  const turns = (count: number, size: number) =>
    Array.from({ length: count }, (_, index) => ({
      role: (index % 2 ? "Assistant" : "User") as "User" | "Assistant",
      text: `${index}`.padEnd(size, "x"),
    }));

  it("hands a transcript that fits straight through", () => {
    const messages = turns(4, 50);
    expect(capTranscriptMessages(messages, 20_000)).toBe(messages);
  });

  it("keeps the head and the tail whole and the message count exact", () => {
    const messages = turns(40, 4_000);
    const capped = capTranscriptMessages(messages, 20_000);

    // The main process stores messages.length as its incremental cursor, so a
    // dropped message would make every later digest slice at the wrong place.
    expect(capped).toHaveLength(messages.length);
    expect(capped.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    const total = capped.reduce((sum, message) => sum + message.text.length, 0);
    expect(total).toBeLessThan(20_000);
    expect(capped[0]).toEqual(messages[0]);
    expect(capped[capped.length - 1]).toEqual(messages[messages.length - 1]);
    // Text the summariser never sees, and never an empty entry: the main process
    // drops those, which would change the count.
    expect(capped[20].text).toBe("[]");
  });
});
