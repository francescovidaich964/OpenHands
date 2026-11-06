import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationLaunchView } from "#/components/features/chat/conversation-launch-view";
import { NavigationProvider } from "#/context/navigation-context";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import { useConversationLaunchStore } from "#/stores/conversation-launch-store";
import { useConversationStore } from "#/stores/conversation-store";

vi.mock("#/components/features/chat/interactive-chat-box", () => ({
  InteractiveChatBox: () => <textarea disabled aria-label="Message" />,
}));

vi.mock(
  "#/components/features/conversation/conversation-main/conversation-main",
  () => ({
    ConversationMain: ({ children }: React.PropsWithChildren) => (
      <>{children}</>
    ),
  }),
);

const navigate = vi.fn();
function view(id: string) {
  return (
    // The launch view renders the prompt through ChatMessage, whose jump-to-event
    // hook reads the conversation query — so it needs a QueryClient like any other
    // screen that shows a message bubble.
    <QueryClientProvider client={new QueryClient()}>
      <ActiveBackendProvider>
        <NavigationProvider
          value={{
            navigate,
            currentPath: `/conversations/${id}`,
            conversationId: id,
            isNavigating: false,
          }}
        >
          <ConversationLaunchView launchId={id} />
        </NavigationProvider>
      </ActiveBackendProvider>
    </QueryClientProvider>
  );
}
function begin() {
  return useConversationLaunchStore.getState().begin({
    backendId: "cloud",
    orgId: "org-1",
    message: "Please investigate",
    files: [],
  });
}

beforeEach(() => {
  navigate.mockClear();
  useConversationLaunchStore.setState({ launches: {} });
  useConversationStore.getState().clearAllFiles();
  useConversationStore.getState().clearMessageToSend();
  setRegisteredBackends([
    {
      id: "cloud",
      name: "Cloud",
      host: "https://example.test",
      apiKey: "",
      kind: "cloud",
    },
  ]);
  setActiveSelection({ backendId: "cloud", orgId: "org-1" });
});
afterEach(() => {
  setRegisteredBackends([]);
});

describe("pending conversation navigation", () => {
  it("shows the prompt immediately and follows an accepted start only when the user returns", () => {
    const id = begin();
    const page = render(view(id));
    expect(screen.getByText("Please investigate")).toBeVisible();
    expect(screen.getByRole("textbox")).toBeDisabled();
    page.unmount();
    act(() =>
      useConversationLaunchStore
        .getState()
        .update(id, { targetId: "task-123" }),
    );
    expect(navigate).not.toHaveBeenCalled();
    render(view(id));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      "/conversations/task-123",
      { replace: true },
    );
  });

  it("keeps a failed prompt and files available to edit", () => {
    const file = new File(["notes"], "notes.txt");
    const id = useConversationLaunchStore.getState().begin({
      backendId: "cloud",
      orgId: "org-1",
      message: "Read my notes",
      files: [file],
      attachments: {
        content: "Read my notes",
        files: [file],
        images: [],
        imagesMarkedUploadAsFile: [],
      },
    });
    const page = render(view(id));
    act(() =>
      useConversationLaunchStore
        .getState()
        .update(id, { error: "Cannot start" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot start");
    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "BUTTON$EDIT" }));
    expect(useConversationStore.getState().messageToSend).toMatchObject({
      text: "Read my notes",
      target: "home",
    });
    expect(useConversationStore.getState().files).toEqual([file]);
    expect(navigate).toHaveBeenCalledWith("/conversations");
    expect(screen.getByText("Read my notes")).toBeVisible();
    page.unmount();
    expect(useConversationLaunchStore.getState().launches[id]).toBeUndefined();
  });

  it("does not reveal a pending prompt or redirect after switching organizations", () => {
    const id = begin();
    useConversationLaunchStore
      .getState()
      .update(id, { targetId: "task-private" });
    setActiveSelection({ backendId: "cloud", orgId: "org-2" });
    render(view(id));
    expect(screen.queryByText("Please investigate")).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "COMMON$BACK" })).toBeVisible();
  });
});
