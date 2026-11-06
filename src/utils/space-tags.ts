/**
 * Spaces (fork feature): a user-created group of conversations whose new
 * members start with a summary of the others (Devin's "spaces").
 *
 * Membership rides on a server-side conversation tag (`canvasspace=<spaceId>`)
 * so it survives another device or a cleared browser profile, exactly like
 * `pinned` / `archived` do (see `conversation-tag-flags.ts`). The space object
 * itself (title, order, collapse state) is a Canvas-local record in
 * `stores/space-store.ts`.
 *
 * The key deliberately is NOT `plannerparent`: that key drives the planner's
 * delete cascade (`getLocalPlanningConversationIds`), which would delete a
 * user's space members when the parent conversation is deleted.
 */
export const SPACE_TAG_KEY = "canvasspace";

/** Space id this conversation belongs to, or null when it belongs to none. */
export function spaceIdFromTags(
  tags: Record<string, string> | null | undefined,
): string | null {
  const value = tags?.[SPACE_TAG_KEY];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Complete tag map with the space link applied — the local agent-server PATCH
 * replaces the whole map, so callers must merge (same contract as
 * `withConversationTagFlags`). Moving out deletes the key.
 */
export function withSpaceTag(
  tags: Record<string, string> | null | undefined,
  spaceId: string | null,
): Record<string, string> {
  const next: Record<string, string> = { ...(tags ?? {}) };
  if (spaceId) {
    next[SPACE_TAG_KEY] = spaceId;
  } else {
    delete next[SPACE_TAG_KEY];
  }
  return next;
}
