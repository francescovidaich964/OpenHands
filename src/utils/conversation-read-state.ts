import { ExecutionStatus } from "#/types/agent-server/core/base/common";
import { hasConversationTagFlag } from "#/utils/conversation-tag-flags";

/**
 * Read state ("this conversation has output I have not looked at yet").
 *
 * This module is the only place that knows how read state is stored and
 * derived, so moving onto the typed upstream field is a one-file change:
 * `OpenHands/software-agent-sdk#4858` persists `last_read_at` on the
 * conversation and returns a derived `unread` boolean on the list and detail
 * responses (`unread = execution_status.is_terminal() and (last_read_at is
 * None or updated_at > last_read_at)`), with `PATCH {unread: true|false}` to
 * set it. That PR is still open, and the released agent-server we run against
 * has neither, so this fork stores the manual marker as the server-side tag
 * `unread=true` — the same mechanism `pinned` / `archived` already use
 * (`conversation-tag-flags.ts`), which works on the local agent-server (its
 * PATCH replaces the tag map) *and* on Cloud (merge patch), and needs no
 * backend change. As soon as a backend reports `unread`, the server value wins
 * below and the tag stops being the source of truth.
 *
 * Detection of "the agent produced output while I was not looking", from data
 * the sidebar list already carries:
 *
 * 1. A manual "Mark as unread" tag always reads as unread (the Devin-style
 *    flag: a conversation you deliberately left yourself a note on).
 * 2. Otherwise, a conversation is unread when its agent output is *terminal*
 *    (finished / error / stuck — the same set upstream uses, and what keeps a
 *    still-running row reading as "working" instead of "new") and its
 *    `updated_at` is newer than the moment this device last had it open.
 * 3. A conversation that was never opened on this device is not unread: with
 *    no timestamp to compare there is nothing honest to say, and treating
 *    "unknown" as unread would light up every pre-existing row on first start.
 *
 * The comparison uses the *server's* `updated_at` as the viewed timestamp (see
 * `rememberConversationViewed`), not the browser clock: the local agent-server
 * stamps `updated_at` on every metadata PATCH, so pinning a row also "touches"
 * it, and a wall-clock comparison would then invent unread rows the user is
 * looking at. Comparing two server timestamps on one clock cannot do that.
 */

/** Tag key holding the manual unread marker (lowercase: see the tag-key rule
 * in `conversation-tag-flags.ts`). */
export const UNREAD_CONVERSATION_TAG_KEY = "unread";

/** localStorage key for the per-(backend, conversation) viewed markers. */
export const CONVERSATION_VIEWED_STORAGE_KEY =
  "openhands-conversation-viewed-by-backend";

/**
 * Execution statuses whose output is complete enough to be "waiting to be
 * read". Mirrors `ConversationExecutionStatus.is_terminal()` in the SDK, which
 * is what the upstream `unread` derivation uses.
 */
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  ExecutionStatus.FINISHED,
  ExecutionStatus.ERROR,
  ExecutionStatus.STUCK,
]);

/** The fields read state needs; `AppConversation` satisfies it structurally. */
export interface ConversationReadStateSource {
  tags?: Record<string, string> | null;
  execution_status?: ExecutionStatus | null;
  updated_at?: string | null;
  /** Present once the backend ships software-agent-sdk#4858. */
  unread?: boolean;
}

export function isUnreadConversationTag(
  tags: Record<string, string> | null | undefined,
): boolean {
  return hasConversationTagFlag(tags, UNREAD_CONVERSATION_TAG_KEY);
}

/**
 * The changes to send to `use-update-conversation-tag-flags` to mark a
 * conversation read or unread. Marking read *deletes* the tag rather than
 * storing `unread=false`, matching how pin and archive are cleared.
 */
export function conversationUnreadTagChanges(
  unread: boolean,
): Record<string, boolean> {
  return { [UNREAD_CONVERSATION_TAG_KEY]: unread };
}

export function isConversationUnread(
  conversation: ConversationReadStateSource,
  viewedAt: string | null,
): boolean {
  if (isUnreadConversationTag(conversation.tags)) return true;
  if (typeof conversation.unread === "boolean") return conversation.unread;

  if (!conversation.execution_status) return false;
  if (!TERMINAL_EXECUTION_STATUSES.has(conversation.execution_status)) {
    return false;
  }
  if (viewedAt == null) return false;

  const updatedAt = Date.parse(conversation.updated_at ?? "");
  const viewedTime = Date.parse(viewedAt);
  if (Number.isNaN(updatedAt) || Number.isNaN(viewedTime)) return false;
  return updatedAt > viewedTime;
}

function viewedKey(backendId: string, conversationId: string): string {
  return `${backendId}::${conversationId}`;
}

function readViewedMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CONVERSATION_VIEWED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeViewedMap(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CONVERSATION_VIEWED_STORAGE_KEY,
      JSON.stringify(map),
    );
  } catch {
    /* ignore quota / serialization errors: read state degrades to manual-only */
  }
}

/** The `updated_at` value this device last saw while the conversation was open. */
export function getLastViewedAt(
  backendId: string,
  conversationId: string,
): string | null {
  return readViewedMap()[viewedKey(backendId, conversationId)] ?? null;
}

/**
 * Every viewed marker for one backend, keyed by conversation id. For lists:
 * reading the store once is one parse, while asking per row would parse the
 * whole map for every conversation in the sidebar.
 */
export function getViewedAtByConversationId(
  backendId: string,
): Map<string, string> {
  const prefix = `${backendId}::`;
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(readViewedMap())) {
    if (key.startsWith(prefix)) out.set(key.slice(prefix.length), value);
  }
  return out;
}

/**
 * Records that the conversation has just been read, using the server's own
 * `updated_at` for it. Writing it forward (rather than "now") is deliberate:
 * anything the server already folded into that timestamp has been seen, and
 * later output gets a strictly newer one.
 *
 * The marker only ever moves forward. A cached or rolled-back list entry can
 * hand back an older `updated_at` than the one already stored, and storing
 * that would bring back an unread marker for output the user has read.
 *
 * shortcut: markers for deleted conversations are never pruned (they are tiny,
 * only read for conversations that exist, and the map is one localStorage key);
 * prune it if the key ever shows up in a storage audit.
 */
export function rememberConversationViewed(
  backendId: string,
  conversationId: string,
  viewedAt: string | null | undefined,
): boolean {
  if (!conversationId || !viewedAt) return false;
  const viewedTime = Date.parse(viewedAt);
  if (Number.isNaN(viewedTime)) return false;

  const map = readViewedMap();
  const key = viewedKey(backendId, conversationId);
  const stored = map[key];
  if (stored != null && Date.parse(stored) >= viewedTime) return false;

  map[key] = viewedAt;
  writeViewedMap(map);
  return true;
}
