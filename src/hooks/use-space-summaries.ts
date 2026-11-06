import { useEffect, useMemo, useState } from "react";
import { selectSpaceMemberIds, useSpaceStore } from "#/stores/space-store";
import {
  hydrateSpaceSummaries,
  refreshSpaceSummaries,
} from "#/utils/space-summary-runner";

/**
 * Keeps a space's digests fresh while one of its conversations is open, and
 * reports what the composer chip should say.
 *
 * Devin triggers a summariser run when a child is created and at every send
 * (reports/D4.md §1.2); the equivalent here is "when a conversation of the
 * space is opened" — the new conversation a user just started is exactly the
 * moment the digests matter, and each conversation only sends the messages it
 * has not summarised yet (`messageCount` cursor).
 */
export function useSpaceSummaries(conversationId: string | null | undefined): {
  spaceId: string | null;
  spaceTitle: string;
  memberCount: number;
  isSummarizing: boolean;
  failed: boolean;
  /** The next (first) message of this conversation carries the block. */
  willIncludeContext: boolean;
} {
  const members = useSpaceStore((state) => state.members);
  const spaces = useSpaceStore((state) => state.spaces);
  const contextInjected = useSpaceStore((state) => state.contextInjected);

  const spaceId = conversationId ? (members[conversationId] ?? null) : null;

  const memberIds = useMemo(
    () =>
      spaceId ? selectSpaceMemberIds(useSpaceStore.getState(), spaceId) : [],
    // `members` is the trigger: the store is read inside so the selector can
    // stay a stable reference (a fresh array per render would loop).
    [spaceId, members],
  );
  const memberKey = memberIds.join(",");

  const [status, setStatus] = useState<"idle" | "running" | "failed">("idle");

  useEffect(() => {
    if (!spaceId || memberKey === "") return;
    const ids = memberKey.split(",");
    let cancelled = false;
    setStatus("running");

    // The files on disk are the source of truth, then the fan-out.
    void hydrateSpaceSummaries()
      .then(() => refreshSpaceSummaries(ids))
      .then((outcome) => {
        if (cancelled) return;
        setStatus(outcome.failed > 0 ? "failed" : "idle");
      });

    return () => {
      cancelled = true;
    };
  }, [spaceId, memberKey]);

  return {
    spaceId,
    spaceTitle: spaceId ? (spaces[spaceId]?.title ?? "") : "",
    memberCount: memberIds.length,
    isSummarizing: status === "running",
    failed: status === "failed",
    willIncludeContext:
      Boolean(spaceId) &&
      memberIds.length > 1 &&
      !(conversationId && contextInjected[conversationId]),
  };
}
