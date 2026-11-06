import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SPACE_CONTEXT_INTRO } from "#/utils/space-context";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock("#/contexts/conversation-websocket-context", () => ({
  useConversationWebSocket: () => ({ sendMessage }),
}));
vi.mock("#/hooks/use-conversation-id", () => ({
  useOptionalConversationId: () => ({ conversationId: "c-me" }),
}));

import { useSendMessage } from "#/hooks/use-send-message";
import { useSpaceStore } from "#/stores/space-store";

const state = () => useSpaceStore.getState();

const message = (text: string) => ({
  action: "message",
  args: { content: text },
});

async function send(text: string) {
  const { result } = renderHook(() => useSendMessage());
  return { send: await result.current.send(message(text)), result };
}

beforeEach(() => {
  localStorage.clear();
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ queued: false });
  useSpaceStore.setState({
    spaces: {},
    spaceOrder: [],
    members: {},
    titles: {},
    summaries: {},
    contextInjected: {},
    collapsedSpaceIds: [],
  });
});

describe("useSendMessage and space context", () => {
  it("puts the space block in front of the first message", async () => {
    const spaceId = state().createSpace("Release prep");
    state().assignSpace("c-me", spaceId);
    state().assignSpace("c-other", spaceId);
    state().rememberConversationTitle("c-other", "Auth work");
    state().setSummary("c-other", "## Overview\nShipped auth.", 5);

    const { send: sent } = await send("now write the release notes");

    expect(sent).toEqual({ queued: false });
    const payload = sendMessage.mock.calls[0][0] as unknown as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(payload.role).toBe("user");
    expect(payload.content).toHaveLength(2);
    expect(payload.content[0].text).toContain(
      '<project_context name="Release prep">',
    );
    expect(payload.content[0].text).toContain(SPACE_CONTEXT_INTRO);
    expect(payload.content[0].text).toContain('<session title="Auth work">');
    expect(payload.content[1].text).toBe("now write the release notes");
    expect(state().contextInjected["c-me"]).toBe(true);
  });

  it("sends later messages without it", async () => {
    const spaceId = state().createSpace("Release prep");
    state().assignSpace("c-me", spaceId);
    state().assignSpace("c-other", spaceId);
    state().setSummary("c-other", "digest", 2);

    await send("first");
    sendMessage.mockClear();
    const { send: sent } = await send("second");

    const payload = sendMessage.mock.calls[0][0] as unknown as {
      content: Array<{ text: string }>;
    };
    expect(payload.content).toHaveLength(1);
    expect(payload.content[0].text).toBe("second");
    void sent;
  });

  it("leaves a conversation that is in no space exactly as it was", async () => {
    await send("hello");
    const payload = sendMessage.mock.calls[0][0] as unknown as {
      content: Array<{ type: string; text: string }>;
    };
    expect(payload.content).toEqual([{ type: "text", text: "hello" }]);
    expect(state().contextInjected["c-me"]).toBeUndefined();
  });

  it("keeps the context for the retry when the send fails", async () => {
    const spaceId = state().createSpace("S");
    state().assignSpace("c-me", spaceId);
    state().assignSpace("c-other", spaceId);
    state().setSummary("c-other", "digest", 2);

    sendMessage.mockRejectedValueOnce(new Error("socket closed"));
    const { result } = renderHook(() => useSendMessage());
    await expect(result.current.send(message("first"))).rejects.toThrow(
      "socket closed",
    );
    expect(state().contextInjected["c-me"]).toBeUndefined();

    // the retry still carries it
    await result.current.send(message("first"));
    const payload = sendMessage.mock.calls[1][0] as unknown as {
      content: Array<{ text: string }>;
    };
    expect(payload.content).toHaveLength(2);
    expect(state().contextInjected["c-me"]).toBe(true);
  });

  it("keeps images attached after the block is inserted", async () => {
    const spaceId = state().createSpace("S");
    state().assignSpace("c-me", spaceId);
    state().assignSpace("c-other", spaceId);
    state().setSummary("c-other", "digest", 2);

    const { result } = renderHook(() => useSendMessage());
    await result.current.send({
      action: "message",
      args: { content: "look at this", image_urls: ["file:///a.png"] },
    });

    const payload = sendMessage.mock.calls[0][0] as unknown as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(payload.content.map((part) => part.type)).toEqual([
      "text",
      "text",
      "image",
    ]);
  });
});
