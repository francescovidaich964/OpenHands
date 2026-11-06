import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";
import {
  createMockConversation,
  renderConversationPanel,
  setupConversationPanelTest,
} from "./conversation-panel-test-utils";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { useConversationPanelPreferencesStore } from "#/stores/conversation-panel-preferences-store";
import { useSpaceStore } from "#/stores/space-store";

vi.mock("#/hooks/mutation/use-unified-stop-conversation", () => ({
  useUnifiedPauseConversation: () => ({ mutate: vi.fn() }),
}));
vi.mock("#/utils/custom-toast-handlers", () => ({
  displaySuccessToast: vi.fn(),
  displayErrorToast: vi.fn(),
  TOAST_OPTIONS: {},
}));

const SPACE_ID = "space-x";

const spaceMember = (overrides: Partial<AppConversation>) =>
  createMockConversation({
    ...overrides,
    tags: { ...(overrides.tags ?? {}), canvasspace: SPACE_ID },
  });

const mockList = (items: AppConversation[]) =>
  vi
    .spyOn(AgentServerConversationService, "searchConversations")
    .mockResolvedValue({
      items,
      next_page_id: null,
    });

describe("ConversationPanel space folders", () => {
  setupConversationPanelTest();

  beforeEach(() => {
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

  it("shows a space member once, inside its folder, instead of also in the list", async () => {
    mockList([
      spaceMember({ id: "1", title: "Member A" }),
      createMockConversation({ id: "2", title: "Plain B" }),
    ]);

    renderConversationPanel();

    // Membership rides on the tag, so the folder exists without the user
    // creating it in this session.
    const folder = await screen.findByTestId(`space-folder-${SPACE_ID}`);
    expect(within(folder).getByText("Member A")).toBeInTheDocument();
    expect(screen.getByText("Plain B")).toBeInTheDocument();
    // The duplicate this is about: one row for the member, not two.
    expect(screen.getAllByText("Member A")).toHaveLength(1);
  });

  it("keeps a folder's members inside the active filter", async () => {
    mockList([
      spaceMember({
        id: "1",
        title: "Nightly Member",
        tags: { automationname: "Nightly Audit", automationtrigger: "cron" },
      }),
      createMockConversation({ id: "2", title: "Plain B" }),
    ]);

    renderConversationPanel();
    expect(await screen.findByText("Nightly Member")).toBeInTheDocument();

    act(() =>
      useConversationPanelPreferencesStore.setState({
        automationFilterMode: "hide-automations",
      }),
    );

    // The folder stays; the member it may not show goes with every other
    // automation row.
    await waitFor(() =>
      expect(screen.queryByText("Nightly Member")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId(`space-folder-${SPACE_ID}`)).toBeInTheDocument();
    expect(screen.getByText("Plain B")).toBeInTheDocument();
  });
});
