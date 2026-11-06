import { describe, expect, it } from "vitest";

import { transcriptMessagesFromEvents } from "#/utils/space-transcript";
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
