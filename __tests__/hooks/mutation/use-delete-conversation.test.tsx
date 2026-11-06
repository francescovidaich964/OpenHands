import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import type { AcpSessionDeleteOutcome } from "#/api/conversation-service/agent-server-conversation-service.types";
import { useDeleteConversation } from "#/hooks/mutation/use-delete-conversation";
import { I18nKey } from "#/i18n/declaration";
import {
  displaySuccessToast,
  displayWarningToast,
} from "#/utils/custom-toast-handlers";

// The hook notices with i18n strings; keep them assertable as the key plus the
// interpolated reason.
vi.mock("#/i18n", () => ({
  default: {
    t: (key: string, vars?: { error?: string }) =>
      vars?.error ? `${key}: ${vars.error}` : key,
  },
}));

vi.mock("#/utils/custom-toast-handlers", () => ({
  displaySuccessToast: vi.fn(),
  displayWarningToast: vi.fn(),
}));

/** Deletes one conversation through the hook and returns nothing but the call. */
async function deleteConversation(
  outcome: AcpSessionDeleteOutcome | null,
  variables: { conversationId: string; agentSessionToast?: boolean } = {
    conversationId: "conv-1",
  },
) {
  vi.spyOn(
    AgentServerConversationService,
    "deleteConversation",
  ).mockResolvedValue(outcome);

  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const { result } = renderHook(() => useDeleteConversation(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

  await result.current.mutateAsync(variables);
}

describe("useDeleteConversation agent-session notice", () => {
  it("says so when the agent's own session went away with the conversation", async () => {
    await deleteConversation({
      acp_session_deleted: true,
      acp_session_delete_error: null,
    });

    expect(displaySuccessToast).toHaveBeenCalledWith(
      I18nKey.CONVERSATION$DELETE_AGENT_SESSION_SUCCESS,
    );
    expect(displayWarningToast).not.toHaveBeenCalled();
  });

  it("carries the agent's reason when its session survived the delete", async () => {
    await deleteConversation({
      acp_session_deleted: false,
      acp_session_delete_error: "delete: connection closed",
    });

    expect(displayWarningToast).toHaveBeenCalledWith(
      `${I18nKey.CONVERSATION$DELETE_AGENT_SESSION_FAILED}: delete: connection closed`,
    );
    expect(displaySuccessToast).not.toHaveBeenCalled();
  });

  it("stays quiet when the backend has nothing to report", async () => {
    await deleteConversation(null);

    expect(displaySuccessToast).not.toHaveBeenCalled();
    expect(displayWarningToast).not.toHaveBeenCalled();
  });

  it("stays quiet for a bulk delete, which reports an aggregate result", async () => {
    await deleteConversation(
      { acp_session_deleted: true, acp_session_delete_error: null },
      { conversationId: "conv-1", agentSessionToast: false },
    );

    expect(displaySuccessToast).not.toHaveBeenCalled();
    expect(displayWarningToast).not.toHaveBeenCalled();
  });
});

describe("useDeleteConversation", () => {
  it("invalidates the conversation list and start-tasks queries on settle", async () => {
    vi.spyOn(
      AgentServerConversationService,
      "deleteConversation",
    ).mockResolvedValue(null);

    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteConversation(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await result.current.mutateAsync({ conversationId: "conv-1" });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["user", "conversations"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["start-tasks"],
      });
    });
  });

  it("still invalidates both queries when the delete request fails", async () => {
    vi.spyOn(
      AgentServerConversationService,
      "deleteConversation",
    ).mockRejectedValue(new Error("boom"));

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteConversation(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await expect(
      result.current.mutateAsync({ conversationId: "conv-1" }),
    ).rejects.toThrow("boom");

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["user", "conversations"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["start-tasks"],
      });
    });
  });
});
