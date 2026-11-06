import { useEffect, useMemo, useState } from "react";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";
import { useUpdateConversationTagFlags } from "#/hooks/mutation/use-update-conversation-tag-flags";
import {
  conversationUnreadTagChanges,
  getViewedAtByConversationId,
  isUnreadConversationTag,
  rememberConversationViewed,
} from "#/utils/conversation-read-state";

interface UseConversationReadStateArgs {
  /** Active backend id: read markers are per-backend, like conversation ids. */
  backendId: string;
  /** The conversations the sidebar already has loaded. */
  conversations: readonly AppConversation[];
  /** The conversation the user is looking at, or null. */
  conversationId: string | null;
}

/**
 * Owns the sidebar's read state: which conversations have output the user has
 * not opened yet, and what happens when they open one.
 *
 * Returns the last-viewed marker per conversation id, for
 * `isConversationUnread`. The store is parsed once per change here, not once per
 * rendered row, and it is derived with a memo rather than copied into state from
 * an effect: an effect that writes state every time the conversation list
 * changes re-renders the panel, which changes the list again, and the sidebar
 * never settles. Only a real storage write bumps `revision`.
 *
 * Opening a conversation records it as viewed (which is what stops a finished row
 * from reading as unread once you have read it) and clears a manual `unread` tag
 * the row may still carry, so opening marks it read. Only the open conversation is
 * written, and the tag is only PATCHed when it is actually set, so normal browsing
 * costs no requests; the write rides the same optimistic mutation that pin and
 * archive use, so the badge goes away immediately.
 */
export function useConversationReadState({
  backendId,
  conversations,
  conversationId,
}: UseConversationReadStateArgs): Map<string, string> {
  // `mutate` is stable across renders; the object `useMutation` returns is not,
  // and depending on that would re-run this effect after every panel render.
  const { mutate: updateConversationTagFlags } =
    useUpdateConversationTagFlags();
  const [revision, setRevision] = useState(0);

  const active = conversationId
    ? conversations.find((candidate) => candidate.id === conversationId)
    : undefined;
  const activeId = active?.id;
  const activeUpdatedAt = active?.updated_at;
  const activeTags = active?.tags;
  const activeHasUnreadTag = isUnreadConversationTag(activeTags);

  useEffect(() => {
    if (!activeId) return;
    if (rememberConversationViewed(backendId, activeId, activeUpdatedAt)) {
      setRevision((current) => current + 1);
    }
    if (!activeHasUnreadTag) return;
    updateConversationTagFlags({
      conversationId: activeId,
      currentTags: activeTags,
      changes: conversationUnreadTagChanges(false),
    });
  }, [
    activeHasUnreadTag,
    activeId,
    activeTags,
    activeUpdatedAt,
    backendId,
    updateConversationTagFlags,
  ]);

  return useMemo(
    () => getViewedAtByConversationId(backendId),
    // `revision` is the only signal that the store changed behind React.
    [backendId, revision],
  );
}
