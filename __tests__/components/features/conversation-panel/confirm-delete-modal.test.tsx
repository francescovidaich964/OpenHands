import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "test-utils";
import { ConfirmDeleteModal } from "#/components/features/conversation-panel/confirm-delete-modal";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  Trans: ({
    values,
    components,
  }: {
    values: { title: string };
    components: { title: React.ReactElement };
  }) => React.cloneElement(components.title, {}, values.title),
}));

describe("ConfirmDeleteModal", () => {
  it("should display the conversation title", () => {
    renderWithProviders(
      <ConfirmDeleteModal
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        conversationTitle="My Test Conversation"
      />,
    );

    expect(screen.getByText(/My Test Conversation/)).toBeInTheDocument();
  });

  it("falls back to the default warning when description is null", () => {
    renderWithProviders(
      <ConfirmDeleteModal
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        description={null}
      />,
    );

    expect(screen.getByText("CONVERSATION$DELETE_WARNING")).toBeInTheDocument();
  });

  it("places Cancel before Confirm in the footer so the dominant action is the last focusable button", () => {
    // Arrange: render the modal so both footer buttons are mounted.
    renderWithProviders(
      <ConfirmDeleteModal onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    // Act: locate both footer buttons.
    const cancel = screen.getByText("BUTTON$CANCEL");
    const confirm = screen.getByText("ACTION$CONFIRM_DELETE");

    // Assert: Cancel precedes the dominant Confirm action in DOM order.
    expect(
      cancel.compareDocumentPosition(confirm) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders buttons with cancel-button and confirm-button test ids", () => {
    // Arrange: render the modal.
    renderWithProviders(
      <ConfirmDeleteModal onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert: buttons expose the expected data-testid attributes.
    expect(screen.getByTestId("cancel-button")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-button")).toBeInTheDocument();
  });

  // #40: an ACP agent keeps its own session store (opencode's session DB, a
  // Claude Code transcript) that the conversation delete now also clears, and
  // that copy is invisible in the app — so the dialog has to say it.
  it("states that the agent's own session is deleted for an ACP conversation", () => {
    renderWithProviders(
      <ConfirmDeleteModal
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        conversationTitle="ACP run"
        agentKind="acp"
      />,
    );

    expect(screen.getByTestId("agent-session-delete-note")).toHaveTextContent(
      "CONVERSATION$DELETE_AGENT_SESSION_NOTE",
    );
    // The ordinary warning still explains the conversation itself.
    expect(screen.getByText(/ACP run/)).toBeInTheDocument();
  });

  it("does not mention an agent session for an OpenHands conversation", () => {
    renderWithProviders(
      <ConfirmDeleteModal
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        conversationTitle="LLM run"
        agentKind="openhands"
      />,
    );

    expect(
      screen.queryByTestId("agent-session-delete-note"),
    ).not.toBeInTheDocument();
  });

  it("does not mention an agent session when the agent kind is unknown (e.g. delete all)", () => {
    const title = "CONVERSATION$CONFIRM_DELETE_ALL_TITLE";
    const description = "CONVERSATION$CONFIRM_DELETE_ALL_DESC";

    renderWithProviders(
      <ConfirmDeleteModal
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title={title}
        description={description}
      />,
    );

    expect(
      screen.queryByTestId("agent-session-delete-note"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
  });
});
