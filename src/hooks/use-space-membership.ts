import { useCallback } from "react";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { useUpdateConversationTags } from "#/hooks/mutation/use-update-conversation-tags";
import { useSpaceStore } from "#/stores/space-store";
import { withSpaceTag } from "#/utils/space-tags";

/**
 * Moves a conversation in or out of a space: the local store first (instant
 * sidebar feedback), then the `canvasspace` tag on the conversation itself.
 *
 * The tag PATCH replaces the whole map, so the current tags are re-read from
 * the backend before merging — a stale copy would drop the workspace/repository
 * tags the server stamps. If that write fails (a backend that will not take
 * the PATCH), the move is rolled back: the sidebar would otherwise show a
 * membership that `syncMembershipFromTags` contradicts on the next list fetch.
 */
export function useSpaceMembership() {
  const { mutateAsync: updateTags } = useUpdateConversationTags();
  const assignSpace = useSpaceStore((state) => state.assignSpace);

  return useCallback(
    async (conversationId: string, spaceId: string | null) => {
      const previous = useSpaceStore.getState().members[conversationId] ?? null;
      if (previous === spaceId) return;

      assignSpace(conversationId, spaceId);
      try {
        const [conversation] =
          await AgentServerConversationService.batchGetAppConversations([
            conversationId,
          ]);
        await updateTags({
          conversationId,
          tags: withSpaceTag(conversation?.tags ?? null, spaceId),
        });
      } catch (error) {
        console.warn(
          "[spaces] Could not save the space tag; the move was rolled back.",
          error,
        );
        assignSpace(conversationId, previous);
      }
    },
    [assignSpace, updateTags],
  );
}
