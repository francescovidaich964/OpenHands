import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpClient } from "@openhands/typescript-client";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";

const { mockDeleteRaw } = vi.hoisted(() => ({ mockDeleteRaw: vi.fn() }));

vi.mock("#/api/cloud/proxy", () => ({
  callCloudProxy: vi.fn().mockResolvedValue(undefined),
}));

// The delete goes out through the raw HttpClient because ConversationClient
// discards the response body the outcome lives in (#40).
vi.mock("@openhands/typescript-client", async () => {
  const actual = await vi.importActual<
    typeof import("@openhands/typescript-client")
  >("@openhands/typescript-client");
  return {
    ...actual,
    HttpClient: vi.fn(function HttpClientMock() {
      return { delete: mockDeleteRaw };
    }),
  };
});

vi.mock("@openhands/typescript-client/clients", async () => {
  const actual = await vi.importActual<
    typeof import("@openhands/typescript-client/clients")
  >("@openhands/typescript-client/clients");
  return {
    ...actual,
    ConversationClient: vi.fn(function ConversationClientMock() {
      return { deleteConversation: vi.fn().mockResolvedValue(undefined) };
    }),
  };
});

const localBackend: Backend = {
  id: "local",
  name: "Local",
  host: "http://127.0.0.1:8001",
  apiKey: "",
  kind: "local",
};

const cloudBackend: Backend = {
  id: "prod",
  name: "Production",
  host: "https://app.all-hands.dev",
  apiKey: "bearer-token",
  kind: "cloud",
};

function select(backend: Backend) {
  setRegisteredBackends([backend]);
  setActiveSelection({ backendId: backend.id });
}

describe("AgentServerConversationService.deleteConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    __resetActiveStoreForTests();
  });

  afterEach(() => {
    window.localStorage.clear();
    __resetActiveStoreForTests();
  });

  it.each([
    [
      "deleted",
      {
        success: true,
        acp_session_deleted: true,
        acp_session_delete_error: null,
      },
      { acp_session_deleted: true, acp_session_delete_error: null },
    ],
    [
      "failed",
      {
        success: true,
        acp_session_deleted: false,
        acp_session_delete_error: "delete: connection closed",
      },
      {
        acp_session_deleted: false,
        acp_session_delete_error: "delete: connection closed",
      },
    ],
    ["older agent-server", { success: true }, null],
  ])(
    "reports the agent-session outcome (%s) from the delete response body",
    async (_case, body, expected) => {
      select(localBackend);
      mockDeleteRaw.mockResolvedValue({ data: body, status: 200 });

      await expect(
        AgentServerConversationService.deleteConversation("conv-1"),
      ).resolves.toEqual(expected);

      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: localBackend.host }),
      );
      expect(mockDeleteRaw).toHaveBeenCalledWith("/api/conversations/conv-1");
    },
  );

  it("has no outcome to report for a cloud conversation", async () => {
    select(cloudBackend);

    await expect(
      AgentServerConversationService.deleteConversation("conv-1"),
    ).resolves.toBeNull();

    expect(HttpClient).not.toHaveBeenCalled();
  });
});
