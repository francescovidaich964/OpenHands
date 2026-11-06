import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "test-utils";
import { ConversationCardContextMenu } from "#/components/features/conversation-panel/conversation-card/conversation-card-context-menu";

vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => ({ backend: { kind: "local" } }),
}));

const renderMenu = (props: Record<string, () => void> = {}) =>
  renderWithProviders(
    <ConversationCardContextMenu onClose={vi.fn()} {...props} />,
  );

describe("ConversationCardContextMenu read actions", () => {
  it("offers Mark as unread for a read conversation", () => {
    renderMenu({ onMarkUnread: vi.fn() });

    expect(screen.getByTestId("mark-unread-button")).toHaveAccessibleName(
      "CONVERSATION$MARK_UNREAD",
    );
    expect(screen.queryByTestId("mark-read-button")).not.toBeInTheDocument();
  });

  it("offers Mark as read once the row is unread", () => {
    renderMenu({ onMarkRead: vi.fn() });

    expect(screen.getByTestId("mark-read-button")).toHaveAccessibleName(
      "CONVERSATION$MARK_READ",
    );
    expect(screen.queryByTestId("mark-unread-button")).not.toBeInTheDocument();
  });

  it("runs the action it was given", async () => {
    const onMarkUnread = vi.fn();
    const onMarkRead = vi.fn();
    renderMenu({ onMarkUnread });

    await userEvent.click(screen.getByTestId("mark-unread-button"));

    expect(onMarkUnread).toHaveBeenCalledTimes(1);
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("still offers the existing row actions", () => {
    renderMenu({
      onMarkUnread: vi.fn(),
      onDelete: vi.fn(),
      onArchive: vi.fn(),
      onEdit: vi.fn(),
      onEditTags: vi.fn(),
    });

    for (const testId of [
      "edit-button",
      "edit-tags-button",
      "archive-button",
      "delete-button",
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });

  it("renders the plain menu when no read action is wired", () => {
    renderMenu({ onDelete: vi.fn() });

    expect(screen.queryByTestId("mark-unread-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("delete-button")).toBeInTheDocument();
  });
});
