import EventService from "#/api/event-service/event-service.api";
import { useSpaceStore } from "#/stores/space-store";
import { loadCompleteTranscriptEvents } from "#/utils/transcript-export/load-complete-events";
import {
  capTranscriptMessages,
  transcriptMessagesFromEvents,
} from "#/utils/space-transcript";
import {
  readStoredSpaceSummaries,
  requestSpaceSummary,
} from "#/utils/space-summary-bridge";
import type { OpenHandsEvent } from "#/types/agent-server/core";

/**
 * Loads a conversation's persisted events (the transcript-export loader, which
 * proves completeness by cursor or by the server's event count) and returns the
 * user/assistant messages the summariser consumes.
 */
async function loadConversationMessages(conversationId: string) {
  const searchEvents = (options: {
    limit: number;
    sortOrder: "TIMESTAMP_DESC";
    pageId?: string;
    timestampLt?: string;
    strictPagination: true;
  }) =>
    EventService.searchEvents(conversationId, null, null, {
      limit: options.limit,
      sortOrder: options.sortOrder,
      ...(options.pageId ? { pageId: options.pageId } : {}),
      ...(options.timestampLt ? { timestampLt: options.timestampLt } : {}),
      strictPagination: true,
    });

  // No `expectedEventCount`: that assertion needs the conversation's url and
  // session key, while the loader already pages by cursor until the server stops
  // handing out page ids and fails loudly on a repeated cursor.
  const events = (await loadCompleteTranscriptEvents(
    [],
    searchEvents,
  )) as OpenHandsEvent[];
  return capTranscriptMessages(transcriptMessagesFromEvents(events));
}

/**
 * Produces or refreshes one conversation's digest (Devin's
 * `{summary, messageCount}` pair, one file per conversation).
 *
 * The whole message list goes to the main process and the *main process* decides
 * what is new: it owns `{messageCount, claudeSessionId}`, so a cleared
 * localStorage cannot make a digest resume a stale session or skip messages.
 *
 * Returns the number of messages the digest covers, or null when there was
 * nothing to do. Throws when the summariser fails: the caller decides whether to
 * say so out loud (Devin keeps starting the conversation without the context).
 */
export async function refreshConversationSummary(
  conversationId: string,
): Promise<number | null> {
  const messages = await loadConversationMessages(conversationId);
  if (messages.length === 0) return null;

  const result = await requestSpaceSummary({ conversationId, messages });
  useSpaceStore
    .getState()
    .setSummary(conversationId, result.summary, result.messageCount);
  return result.messageCount;
}

/**
 * Refreshes every member of a space at once (Devin's parallel
 * all-settled fan-out): one member's summariser failing must not stop the
 * others, and the caller keeps working with whatever digests exist.
 */
export async function refreshSpaceSummaries(memberIds: string[]): Promise<{
  refreshed: number;
  failed: number;
  firstError?: string;
}> {
  const results = await Promise.allSettled(
    memberIds.map((memberId) => refreshConversationSummary(memberId)),
  );
  const failures = results.filter(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult[];
  if (failures.length > 0) {
    // Devin keeps starting the conversation without the context; so do we.
    console.warn(
      "[spaces] Could not summarize some space members:",
      failures[0].reason,
    );
  }
  return {
    refreshed: results.filter(
      (result) => result.status === "fulfilled" && result.value !== null,
    ).length,
    failed: failures.length,
    firstError: failures[0]
      ? String(
          failures[0].reason instanceof Error
            ? failures[0].reason.message
            : failures[0].reason,
        )
      : undefined,
  };
}

/**
 * Folds the digests that are on disk into the local cache (the files are the
 * source of truth, Devin's `parent_summaries` the precedent). Cheap: one IPC
 * call, and nothing is written when a digest already matches.
 */
export async function hydrateSpaceSummaries(): Promise<void> {
  const stored = await readStoredSpaceSummaries();
  const { summaries } = useSpaceStore.getState();
  for (const [conversationId, entry] of Object.entries(stored)) {
    const local = summaries[conversationId];
    if (
      local?.summary === entry.summary &&
      local?.messageCount === entry.messageCount
    ) {
      continue;
    }
    useSpaceStore
      .getState()
      .setSummary(conversationId, entry.summary, entry.messageCount);
  }
}
