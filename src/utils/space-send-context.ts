import {
  buildSpaceContextBlock,
  type SpaceContextBlock,
} from "#/utils/space-context";
import { selectSpaceMemberIds, useSpaceStore } from "#/stores/space-store";

/**
 * The space context a conversation's FIRST user message carries, or null when
 * this send must not carry one.
 *
 * Read-only by design: the caller marks the conversation injected
 * (`useSpaceStore.getState().markContextInjected`) only once the message was
 * actually sent, so a send that throws can still deliver the block on the
 * retry.
 */
export function spaceContextForFirstMessage(
  conversationId: string | null | undefined,
): SpaceContextBlock | null {
  if (!conversationId) return null;

  const state = useSpaceStore.getState();
  const spaceId = state.members[conversationId];
  if (!spaceId) return null;
  if (state.contextInjected[conversationId]) return null;

  const sessions = selectSpaceMemberIds(state, spaceId)
    .filter((memberId) => memberId !== conversationId)
    .map((memberId) => ({
      title: state.titles[memberId] ?? memberId,
      summary: state.summaries[memberId]?.summary ?? null,
    }));
  // A space with no other member has nothing to summarise; Devin's own block
  // for that case carries no <session> at all.
  if (sessions.length === 0) return null;

  const block = buildSpaceContextBlock(
    state.spaces[spaceId]?.title ?? "",
    sessions,
  );
  if (block.droppedSummaryCount > 0 || block.droppedSessionCount > 0) {
    // Our cap, not Devin's: say what was dropped instead of silently trimming.
    console.warn(
      `[spaces] Space context over budget: dropped ${block.droppedSummaryCount} summary(ies) to empty <session/> tags and ${block.droppedSessionCount} member(s) entirely.`,
    );
  }
  // The cap can empty the block (members whose titles alone blow the budget);
  // sending an empty text part would only confuse the bubble matching.
  return block.text ? block : null;
}
