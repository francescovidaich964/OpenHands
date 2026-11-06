// The passage-quote envelope on ChatInterface's send path (R4 finding M3): a
// built-in slash command must go out bare, and the quote must survive it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { useParamsMock } from "test-utils";

import { ChatInterface } from "#/components/features/chat/chat-interface";
import { AgentState } from "#/types/agent-state";
import { useAgentState } from "#/hooks/use-agent-state";
import { useConfig } from "#/hooks/query/use-config";
import {
  useConversationId,
  useOptionalConversationId,
} from "#/hooks/use-conversation-id";
import { useUnifiedUploadFiles } from "#/hooks/mutation/use-unified-upload-files";
import { useTaskPolling } from "#/hooks/query/use-task-polling";
import { useLoadOlderEvents } from "#/hooks/use-load-older-events";
import { useConversationStore } from "#/stores/conversation-store";
import { useEventStore } from "#/stores/use-event-store";
import { useOptimisticUserMessageStore } from "#/stores/optimistic-user-message-store";
import {
  readStagedQuote,
  usePendingQuoteStore,
} from "#/stores/pending-quote-store";
import ProfilesService from "#/api/profiles-service/profiles-service.api";

const CONVERSATION_ID = "test-conversation-id";
const mockSend = vi.fn();

vi.mock("#/hooks/use-send-message", () => ({
  useSendMessage: () => ({ send: mockSend }),
}));

const PASSAGE = {
  eventId: "evt-1",
  author: "agent" as const,
  caption: "",
  content: "the passage",
  truncated: false,
};

/**
 * The selection popup is fed by a document-level `pointerup` listener, which
 * jsdom cannot produce inside a message bubble; the hook is mocked so a draft
 * can be handed to `ChatInterface` directly.
 */
const selection = vi.hoisted(() => ({
  draft: null as unknown,
  dismiss: vi.fn(),
}));

vi.mock("#/hooks/use-message-selection", () => ({
  useMessageSelection: () => ({
    draft: selection.draft as never,
    dismiss: selection.dismiss,
  }),
}));

/**
 * These tests exercise `handleSendMessage`, the one place the envelope is
 * attached. The composer's built-in commands are intercepted upstream of it (and
 * the `/plan` `/code` interceptors hand the task down without the command), so
 * the chain is mocked to pass everything straight through: the guard has to hold
 * for whatever reaches the send path, including the quote popup's own send,
 * which does bypass the interceptors in the real app.
 */
vi.mock("#/hooks/chat/use-btw-interceptor", () => ({
  useBtwInterceptor: (
    _conversationId: string | null | undefined,
    onSubmit: (message: string) => void,
  ) => onSubmit,
}));
vi.mock("#/hooks/chat/use-goal-interceptor", () => ({
  useGoalInterceptor: (
    _conversationId: string | null | undefined,
    onSubmit: (message: string) => void,
  ) => onSubmit,
}));
vi.mock("#/hooks/chat/use-model-interceptor", () => ({
  useModelInterceptor: (
    _conversationId: string | null | undefined,
    onSubmit: (message: string) => void,
  ) => onSubmit,
}));
vi.mock("#/hooks/chat/use-plan-mode-interceptor", () => ({
  usePlanModeInterceptor: (
    _conversationId: string | null | undefined,
    _curAgentState: AgentState,
    onSubmit: (message: string) => void,
  ) => onSubmit,
}));

vi.mock("#/hooks/query/use-config");
vi.mock("#/hooks/mutation/use-unified-upload-files");
vi.mock("#/hooks/use-llm-configured", () => ({
  useLlmConfigured: () => ({ isConfigured: true, isLoading: false }),
}));
vi.mock("#/hooks/use-conversation-id", () => ({
  useConversationId: vi.fn(),
  useOptionalConversationId: vi.fn(),
}));
vi.mock("#/hooks/use-user-providers", () => ({
  useUserProviders: () => ({ providers: [] }),
}));
vi.mock("#/hooks/use-conversation-name-context-menu", () => ({
  useConversationNameContextMenu: () => ({
    isOpen: false,
    contextMenuRef: { current: null },
    handleContextMenu: vi.fn(),
    handleClose: vi.fn(),
    handleRename: vi.fn(),
    handleDelete: vi.fn(),
  }),
}));
vi.mock("#/hooks/use-load-older-events", () => ({
  useLoadOlderEvents: vi.fn(),
}));
vi.mock("#/hooks/query/use-task-polling", () => ({
  useTaskPolling: vi.fn(),
}));
vi.mock("#/hooks/use-agent-state", () => ({
  useAgentState: vi.fn(() => ({
    curAgentState: AgentState.AWAITING_USER_INPUT,
  })),
  usePlanningAgentState: vi.fn(() => ({
    localPlanningConversationId: null,
    curPlanningAgentState: AgentState.AWAITING_USER_INPUT,
    isPlanningAgentRunning: false,
  })),
}));
vi.mock("#/hooks/use-tracking", () => ({
  useTracking: () => ({
    trackInitialQuerySubmitted: vi.fn(),
    trackUserMessageSent: vi.fn(),
  }),
}));

describe("ChatInterface - Passage quote and slash commands", () => {
  let listProfilesSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useParamsMock.mockReturnValue({ conversationId: CONVERSATION_ID });
    vi.mocked(useConversationId).mockReturnValue({
      conversationId: CONVERSATION_ID,
    });
    vi.mocked(useOptionalConversationId).mockReturnValue({
      conversationId: CONVERSATION_ID,
    });
    vi.mocked(useTaskPolling).mockReturnValue({
      isTask: false,
      taskId: null,
      conversationId: CONVERSATION_ID,
      task: undefined,
      taskStatus: undefined,
      taskDetail: undefined,
      taskError: null,
      isLoadingTask: false,
      repositoryInfo: {
        selectedRepository: undefined,
        selectedBranch: undefined,
        gitProvider: undefined,
      },
    });
    vi.mocked(useLoadOlderEvents).mockReturnValue({
      isLoading: false,
      hasMore: false,
      loadOlder: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(useAgentState).mockReturnValue({
      curAgentState: AgentState.AWAITING_USER_INPUT,
    });

    mockSend.mockReset();
    mockSend.mockResolvedValue({ queued: false });
    selection.draft = null;
    usePendingQuoteStore.getState().discard(CONVERSATION_ID);
    usePendingQuoteStore.getState().endEdit();
    useOptimisticUserMessageStore.getState().clearPendingMessages();
    useEventStore.setState({ events: [], eventIds: new Set(), uiEvents: [] });
    (useConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {},
    });
    (
      useUnifiedUploadFiles as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      mutateAsync: vi
        .fn()
        .mockResolvedValue({ skipped_files: [], uploaded_files: [] }),
      isLoading: false,
    });
    listProfilesSpy = vi
      .spyOn(ProfilesService, "listProfiles")
      .mockResolvedValue({
        profiles: [],
        active_profile: null,
      } as Awaited<ReturnType<typeof ProfilesService.listProfiles>>);
  });

  afterEach(() => {
    cleanup();
    listProfilesSpy.mockRestore();
    selection.draft = null;
    usePendingQuoteStore.getState().discard(CONVERSATION_ID);
    useOptimisticUserMessageStore.getState().clearPendingMessages();
  });

  function renderInterface() {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[`/${CONVERSATION_ID}`]}>
          <Routes>
            <Route path=":conversationId" element={<ChatInterface />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  /** The composer forwards `submittedMessage` to the send path (see the
   *  pending-queue tests in chat-interface.test.tsx for the same technique). */
  function submitViaComposer(text: string) {
    act(() => {
      useConversationStore.setState({ submittedMessage: text });
    });
  }

  async function sentWire() {
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    return mockSend.mock.calls[0][0];
  }

  it("sends a built-in slash command without the envelope and keeps the quote staged", async () => {
    usePendingQuoteStore.getState().stage(CONVERSATION_ID, PASSAGE);
    renderInterface();

    submitViaComposer("/model gpt-5");
    const wire = await sentWire();

    // Wrapping the command breaks the downstream command match and leaks the
    // markup to the agent, so it goes out as the user typed it.
    expect(wire.args.content).toBe("/model gpt-5");
    expect(wire.args.extra_text_parts).toEqual([]);
    // ...and the quote is not spent on it: it rides along with the next message.
    expect(readStagedQuote(CONVERSATION_ID)?.content).toBe("the passage");
  });

  it("still attaches a staged quote to an ordinary message and spends it", async () => {
    usePendingQuoteStore.getState().stage(CONVERSATION_ID, PASSAGE);
    renderInterface();

    submitViaComposer("look at this");
    const wire = await sentWire();

    expect(wire.args.content).toBe("look at this");
    expect(wire.args.extra_text_parts).toEqual([
      expect.stringContaining("the passage"),
    ]);
    expect(wire.args.extra_text_parts[0]).toMatch(/^<quoted_artifact\b/);
    expect(readStagedQuote(CONVERSATION_ID)).toBeNull();
  });

  it("runs a slash command sent from the quote popup without the envelope", async () => {
    selection.draft = { quote: PASSAGE, x: 100, y: 100 };
    renderInterface();

    fireEvent.change(screen.getByTestId("quote-caption-input"), {
      target: { value: "/goal ship it" },
    });
    fireEvent.click(screen.getByTestId("quote-primary-button"));
    const wire = await sentWire();

    expect(wire.args.content).toBe("/goal ship it");
    expect(wire.args.extra_text_parts).toEqual([]);
    // The selection is not thrown away with the envelope: it moves to the pill.
    expect(readStagedQuote(CONVERSATION_ID)?.content).toBe("the passage");
  });

  it("sends a captioned quote from the popup as its own text part", async () => {
    selection.draft = { quote: PASSAGE, x: 100, y: 100 };
    renderInterface();

    fireEvent.change(screen.getByTestId("quote-caption-input"), {
      target: { value: "explain this" },
    });
    fireEvent.click(screen.getByTestId("quote-primary-button"));
    const wire = await sentWire();

    expect(wire.args.content).toBe("explain this");
    expect(wire.args.extra_text_parts).toEqual([
      expect.stringContaining("the passage"),
    ]);
  });
});
