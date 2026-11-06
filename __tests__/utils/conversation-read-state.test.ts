import { beforeEach, describe, expect, it } from "vitest";

import { ExecutionStatus } from "#/types/agent-server/core/base/common";
import {
  CONVERSATION_VIEWED_STORAGE_KEY,
  UNREAD_CONVERSATION_TAG_KEY,
  conversationUnreadTagChanges,
  getLastViewedAt,
  isConversationUnread,
  isUnreadConversationTag,
  rememberConversationViewed,
} from "#/utils/conversation-read-state";

const T1 = "2026-11-01T10:00:00.000Z";
const T2 = "2026-11-02T10:00:00.000Z";

const finished = (overrides = {}) => ({
  tags: null,
  execution_status: ExecutionStatus.FINISHED,
  updated_at: T2,
  ...overrides,
});

describe("conversation-read-state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stamps the manual marker under a backend-safe tag key", () => {
    expect(UNREAD_CONVERSATION_TAG_KEY).toMatch(/^[a-z0-9]+$/);
    expect(conversationUnreadTagChanges(true)).toEqual({ unread: true });
    expect(conversationUnreadTagChanges(false)).toEqual({ unread: false });
  });

  it("reads the manual tag in either storage shape", () => {
    expect(isUnreadConversationTag({ unread: "true" })).toBe(true);
    expect(isUnreadConversationTag({ unread: "false" })).toBe(false);
    expect(isUnreadConversationTag({ pinned: "true" })).toBe(false);
    expect(isUnreadConversationTag(null)).toBe(false);
    expect(isUnreadConversationTag(undefined)).toBe(false);
  });

  it("reads a manual marker even when nothing new happened", () => {
    expect(
      isConversationUnread(
        finished({ tags: { [UNREAD_CONVERSATION_TAG_KEY]: "true" } }),
        T2,
      ),
    ).toBe(true);
  });

  it("marks a finished conversation whose output is newer than the last look", () => {
    expect(isConversationUnread(finished(), T1)).toBe(true);
    expect(isConversationUnread(finished(), T2)).toBe(false);
    expect(
      isConversationUnread(
        finished({ updated_at: T1, execution_status: ExecutionStatus.ERROR }),
        T2,
      ),
    ).toBe(false);
  });

  it.each([
    ExecutionStatus.RUNNING,
    ExecutionStatus.IDLE,
    ExecutionStatus.WAITING_FOR_CONFIRMATION,
    ExecutionStatus.PAUSED,
  ])("never marks a conversation that is not terminal (%s)", (status) => {
    expect(
      isConversationUnread(finished({ execution_status: status }), T1),
    ).toBe(false);
  });

  it.each([
    ExecutionStatus.FINISHED,
    ExecutionStatus.ERROR,
    ExecutionStatus.STUCK,
  ])("marks every terminal status (%s)", (status) => {
    expect(
      isConversationUnread(finished({ execution_status: status }), T1),
    ).toBe(true);
  });

  it("does not mark a conversation this device never opened", () => {
    expect(isConversationUnread(finished(), null)).toBe(false);
  });

  it("ignores rows with no execution status and unparseable timestamps", () => {
    expect(isConversationUnread(finished({ execution_status: null }), T1)).toBe(
      false,
    );
    expect(
      isConversationUnread(finished({ updated_at: "not-a-date" }), T1),
    ).toBe(false);
    expect(isConversationUnread(finished(), "not-a-date")).toBe(false);
  });

  it("prefers the server-derived flag once the backend reports one", () => {
    // software-agent-sdk#4858: `unread` computed from `last_read_at`.
    expect(isConversationUnread(finished({ unread: false }), T1)).toBe(false);
    expect(isConversationUnread(finished({ unread: true }), T2)).toBe(true);
    // A manual marker still wins, which is what keeps "Mark as unread" working
    // on a backend that already derives the field.
    expect(
      isConversationUnread(
        finished({
          unread: false,
          tags: { [UNREAD_CONVERSATION_TAG_KEY]: "true" },
        }),
        T2,
      ),
    ).toBe(true);
  });

  it("stores the viewed marker per backend and conversation", () => {
    rememberConversationViewed("backend-a", "conv-1", T1);
    expect(getLastViewedAt("backend-a", "conv-1")).toBe(T1);
    expect(getLastViewedAt("backend-b", "conv-1")).toBeNull();
    expect(getLastViewedAt("backend-a", "conv-2")).toBeNull();
  });

  it("keeps the newest viewed marker and ignores empty writes", () => {
    rememberConversationViewed("backend-a", "conv-1", T2);
    rememberConversationViewed("backend-a", "conv-1", T1);
    rememberConversationViewed("backend-a", "conv-1", undefined);
    rememberConversationViewed("backend-a", "", T2);
    expect(getLastViewedAt("backend-a", "conv-1")).toBe(T2);
  });

  it("survives a corrupted store instead of throwing", () => {
    window.localStorage.setItem(CONVERSATION_VIEWED_STORAGE_KEY, "{nope");
    expect(getLastViewedAt("backend-a", "conv-1")).toBeNull();
    rememberConversationViewed("backend-a", "conv-1", T1);
    expect(getLastViewedAt("backend-a", "conv-1")).toBe(T1);

    window.localStorage.setItem(CONVERSATION_VIEWED_STORAGE_KEY, "[1,2]");
    expect(getLastViewedAt("backend-a", "conv-1")).toBeNull();
  });
});
