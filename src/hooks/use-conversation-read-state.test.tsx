import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";
import { ExecutionStatus } from "#/types/agent-server/core/base/common";
import { useConversationReadState } from "#/hooks/use-conversation-read-state";
import {
  CONVERSATION_VIEWED_STORAGE_KEY,
  UNREAD_CONVERSATION_TAG_KEY,
  getViewedAtByConversationId,
} from "#/utils/conversation-read-state";

const mutate = vi.fn();

vi.mock("#/hooks/mutation/use-update-conversation-tag-flags", () => ({
  useUpdateConversationTagFlags: () => ({ mutate }),
}));

const conversation = (overrides = {}) =>
  ({
    id: "conv-1",
    tags: null,
    execution_status: ExecutionStatus.FINISHED,
    updated_at: "2026-11-02T10:00:00.000Z",
    ...overrides,
  }) as AppConversation;

describe("useConversationReadState", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mutate.mockClear();
  });

  it("records the open conversation as viewed at its server timestamp", () => {
    const { result } = renderHook(() =>
      useConversationReadState({
        backendId: "backend-a",
        conversations: [conversation()],
        conversationId: "conv-1",
      }),
    );

    expect(result.current.get("conv-1")).toBe("2026-11-02T10:00:00.000Z");
    expect(getViewedAtByConversationId("backend-a").get("conv-1")).toBe(
      "2026-11-02T10:00:00.000Z",
    );
  });

  it("clears a manual unread tag when the conversation is opened", async () => {
    renderHook(() =>
      useConversationReadState({
        backendId: "backend-a",
        conversations: [
          conversation({ tags: { [UNREAD_CONVERSATION_TAG_KEY]: "true" } }),
        ],
        conversationId: "conv-1",
      }),
    );

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        conversationId: "conv-1",
        changes: { [UNREAD_CONVERSATION_TAG_KEY]: false },
      }),
    );
  });

  it("sends no request when the open conversation carries no tag", () => {
    renderHook(() =>
      useConversationReadState({
        backendId: "backend-a",
        conversations: [conversation()],
        conversationId: "conv-1",
      }),
    );

    expect(mutate).not.toHaveBeenCalled();
  });

  it("does nothing without an open conversation", () => {
    const { result } = renderHook(() =>
      useConversationReadState({
        backendId: "backend-a",
        conversations: [conversation()],
        conversationId: null,
      }),
    );

    expect(result.current.size).toBe(0);
    expect(
      window.localStorage.getItem(CONVERSATION_VIEWED_STORAGE_KEY),
    ).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("settles instead of re-rendering forever when the list identity changes", async () => {
    // The panel rebuilds its conversation array on every refetch; an effect that
    // wrote state unconditionally would re-render the sidebar in a loop.
    const { result, rerender } = renderHook(
      ({ conversations }) =>
        useConversationReadState({
          backendId: "backend-a",
          conversations,
          conversationId: "conv-1",
        }),
      { initialProps: { conversations: [conversation()] } },
    );

    const first = result.current;
    rerender({ conversations: [conversation({ title: "refetched" })] });
    rerender({ conversations: [conversation({ title: "refetched again" })] });

    expect(result.current).toBe(first);
    expect(mutate).not.toHaveBeenCalled();
  });
});
