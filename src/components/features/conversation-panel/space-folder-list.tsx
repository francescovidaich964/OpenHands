import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Folder,
  FolderOpen,
  ListPlus,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";
import { useCreateConversation } from "#/hooks/mutation/use-create-conversation";
import { useNavigation } from "#/context/navigation-context";
import { useSpaceMembership } from "#/hooks/use-space-membership";
import { I18nKey } from "#/i18n/declaration";
import {
  selectOrderedSpaces,
  selectSpaceMemberIds,
  useSpaceStore,
} from "#/stores/space-store";
import { refreshSpaceSummaries } from "#/utils/space-summary-runner";
import { cn } from "#/utils/utils";

export interface SpaceFolderListProps {
  /**
   * Every conversation the sidebar has loaded: the membership tags are folded
   * from it and the member picker offers all of it. Not what the folders render
   * — see `visibleConversations`.
   */
  conversations: AppConversation[];
  /** The scoped / searched / tag-filtered set the flat list renders from. */
  visibleConversations: AppConversation[];
  renderConversationCard: (conversation: AppConversation) => ReactNode;
  isCreatingConversationFlow: boolean;
}

const ICON_BUTTON_CLASS = cn(
  "inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
  "text-inherit transition-colors hover:bg-contrast/10 hover:text-contrast",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** Newest first, so a new conversation in a space reuses an active workspace. */
function mostRecent<T extends { updated_at?: string | null }>(
  items: T[],
): T | undefined {
  return items
    .slice()
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
}

/**
 * Spaces (fork feature): user-created folders in the sidebar. A space owns its
 * title and its members; starting a conversation from it puts that conversation
 * in the space, and the first message it sends carries the other members'
 * summaries (see `src/utils/space-context.ts`).
 *
 * Deleting a space forgets the group only — its conversations stay, which is
 * Devin's rule and the reason membership must never ride `plannerparent`.
 */
export function SpaceFolderList({
  conversations,
  visibleConversations,
  renderConversationCard,
  isCreatingConversationFlow,
}: SpaceFolderListProps) {
  const { t } = useTranslation("openhands");
  // The app's own navigation seam: it keeps this subtree renderable without a
  // Router (the sidebar's tests mount the panel bare), and it is how the panel
  // itself navigates — plain paths, no backend params (those are for hrefs a
  // new tab can be opened with).
  const { navigate } = useNavigation();
  const { mutate: createConversation } = useCreateConversation();
  const moveConversation = useSpaceMembership();
  // Selectors, not the whole store: every digest hydration would otherwise
  // re-render every folder and every member card.
  const spaces = useSpaceStore((state) => state.spaces);
  const spaceOrder = useSpaceStore((state) => state.spaceOrder);
  const members = useSpaceStore((state) => state.members);
  const collapsedSpaceIds = useSpaceStore((state) => state.collapsedSpaceIds);
  const syncMembershipFromTags = useSpaceStore(
    (state) => state.syncMembershipFromTags,
  );
  const createSpace = useSpaceStore((state) => state.createSpace);
  const renameSpace = useSpaceStore((state) => state.renameSpace);
  const deleteSpace = useSpaceStore((state) => state.deleteSpace);
  const toggleSpaceCollapsed = useSpaceStore(
    (state) => state.toggleSpaceCollapsed,
  );

  // The server-side tags are the source of truth for membership: fold them in
  // (and remember titles for the <session title="…"> attributes).
  useEffect(() => {
    syncMembershipFromTags(
      conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title ?? null,
        tags: conversation.tags ?? null,
      })),
    );
  }, [conversations, syncMembershipFromTags]);

  const visibleConversationsById = useMemo(
    () =>
      new Map(
        visibleConversations.map((conversation) => [
          conversation.id,
          conversation,
        ]),
      ),
    [visibleConversations],
  );

  const orderedSpaces = useMemo(
    () => selectOrderedSpaces({ spaces, spaceOrder }),
    [spaces, spaceOrder],
  );

  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pickerSpaceId, setPickerSpaceId] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<
    Record<string, "running" | "failed">
  >({});

  const startConversationInSpace = useCallback(
    (spaceId: string) => {
      if (isCreatingConversationFlow) return;
      const memberIds = selectSpaceMemberIds(useSpaceStore.getState(), spaceId);
      const sample = mostRecent(
        memberIds
          .map((id) => visibleConversationsById.get(id))
          .filter((conversation): conversation is AppConversation =>
            Boolean(conversation),
          ),
      );
      createConversation(
        {
          workingDir:
            sample?.selected_workspace ??
            sample?.workspace?.working_dir ??
            undefined,
          entryPoint: "sidebar_new_conversation_in_space",
        },
        {
          onSuccess: (data) => {
            void moveConversation(data.conversation_id, spaceId);
            navigate(`/conversations/${data.conversation_id}`);
          },
        },
      );
    },
    [
      createConversation,
      isCreatingConversationFlow,
      moveConversation,
      navigate,
      visibleConversationsById,
    ],
  );

  const refreshSpace = useCallback(async (spaceId: string) => {
    const memberIds = selectSpaceMemberIds(useSpaceStore.getState(), spaceId);
    if (memberIds.length === 0) return;
    setRefreshState((state) => ({ ...state, [spaceId]: "running" }));
    const outcome = await refreshSpaceSummaries(memberIds);
    setRefreshState((state) =>
      Object.fromEntries(
        Object.entries(state)
          .filter(([id]) => id !== spaceId)
          .concat(outcome.failed > 0 ? [[spaceId, "failed"] as const] : []),
      ),
    );
  }, []);

  if (orderedSpaces.length === 0 && draftTitle === null) {
    // Nothing grouped yet: the sidebar shows only the action that creates the
    // first space, so an empty Spaces section never eats vertical space.
    return (
      <div className="pb-1">
        <button
          type="button"
          data-testid="space-create"
          onClick={() => setDraftTitle("")}
          className="flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-1 text-sm text-muted transition-colors hover:bg-surface-raised hover:text-contrast"
        >
          <Plus className="h-4 w-4 shrink-0" aria-hidden />
          <span>{t(I18nKey.SPACE$NEW_SPACE)}</span>
        </button>
      </div>
    );
  }

  return (
    <nav aria-label={t(I18nKey.SPACE$TITLE)} className="space-y-1 pb-1">
      {orderedSpaces.map((space) => {
        const memberIds = selectSpaceMemberIds({ members }, space.id);
        const collapsed = collapsedSpaceIds.includes(space.id);
        // Only the filtered set: a folder lists the same conversations the rest
        // of the sidebar is showing, never ones the scope or search excluded.
        const visibleMembers = memberIds
          .map((id) => visibleConversationsById.get(id))
          .filter((conversation): conversation is AppConversation =>
            Boolean(conversation),
          );
        const testId = space.id.replace(/[^a-zA-Z0-9_-]/g, "-");
        const label = space.title || t(I18nKey.SPACE$UNTITLED);
        const pickerOpen = pickerSpaceId === space.id;
        const refreshing = refreshState[space.id] === "running";
        const refreshFailed = refreshState[space.id] === "failed";

        return (
          <section
            key={space.id}
            data-testid={`space-folder-${testId}`}
            className="rounded-md"
          >
            <div className="flex h-8 w-full min-w-0 items-center gap-0.5 rounded-md pl-2 pr-1 text-sm">
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={t(
                  collapsed
                    ? I18nKey.CONVERSATION_PANEL$EXPAND_FOLDER
                    : I18nKey.CONVERSATION_PANEL$COLLAPSE_FOLDER,
                  { label },
                )}
                onClick={() => toggleSpaceCollapsed(space.id)}
                className="group/folder flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-muted outline-none transition-colors hover:bg-surface-raised hover:text-contrast focus-visible:ring-1 focus-visible:ring-border"
              >
                {collapsed ? (
                  <Folder className="h-4 w-4 shrink-0" aria-hidden />
                ) : (
                  <FolderOpen className="h-4 w-4 shrink-0" aria-hidden />
                )}
                {renamingId === space.id ? (
                  <TitleInput
                    /* eslint-disable jsx-a11y/no-autofocus */
                    autoFocus
                    initial={space.title}
                    onCommit={(title) => {
                      renameSpace(space.id, title);
                      setRenamingId(null);
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                ) : (
                  <span className="truncate">{label}</span>
                )}
                <span className="shrink-0 text-xs text-text-dim">
                  {memberIds.length}
                </span>
              </button>
              <button
                type="button"
                className={ICON_BUTTON_CLASS}
                disabled={isCreatingConversationFlow}
                aria-label={t(I18nKey.SPACE$NEW_CONVERSATION)}
                data-testid={`space-new-conversation-${testId}`}
                onClick={(event) => {
                  event.stopPropagation();
                  startConversationInSpace(space.id);
                }}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
              </button>
              <button
                type="button"
                className={cn(
                  ICON_BUTTON_CLASS,
                  refreshFailed && "text-danger",
                )}
                aria-busy={refreshing}
                aria-label={t(
                  refreshFailed
                    ? I18nKey.SPACE$REFRESH_FAILED
                    : I18nKey.SPACE$REFRESH,
                )}
                title={t(
                  refreshFailed
                    ? I18nKey.SPACE$REFRESH_FAILED
                    : I18nKey.SPACE$REFRESH,
                )}
                data-testid={`space-refresh-${testId}`}
                disabled={refreshing}
                onClick={(event) => {
                  event.stopPropagation();
                  void refreshSpace(space.id);
                }}
              >
                <RefreshCw
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    refreshing && "animate-spin",
                  )}
                  aria-hidden
                />
              </button>
              <button
                type="button"
                className={ICON_BUTTON_CLASS}
                aria-expanded={pickerOpen}
                aria-label={t(I18nKey.SPACE$MEMBERS)}
                data-testid={`space-members-${testId}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setPickerSpaceId(pickerOpen ? null : space.id);
                }}
              >
                <ListPlus className="h-3.5 w-3.5 shrink-0" aria-hidden />
              </button>
              <button
                type="button"
                className={ICON_BUTTON_CLASS}
                aria-label={t(I18nKey.SPACE$RENAME)}
                data-testid={`space-rename-${testId}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setRenamingId(space.id);
                }}
              >
                <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
              </button>
              <button
                type="button"
                className={ICON_BUTTON_CLASS}
                aria-label={t(I18nKey.SPACE$DELETE)}
                data-testid={`space-delete-${testId}`}
                onClick={(event) => {
                  event.stopPropagation();
                  // Members leave first: the tag is what the server keeps, and a
                  // leftover `canvasspace` tag would resurrect this space (as an
                  // untitled folder) the next time the sidebar syncs.
                  const memberIds = selectSpaceMemberIds(
                    useSpaceStore.getState(),
                    space.id,
                  );
                  void Promise.all(
                    memberIds.map((conversationId) =>
                      moveConversation(conversationId, null),
                    ),
                  ).then(() => deleteSpace(space.id));
                  if (pickerOpen) setPickerSpaceId(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
              </button>
            </div>

            {pickerOpen ? (
              <div
                className="mb-1 ml-2 max-h-56 overflow-y-auto rounded-md border border-border bg-surface-raised p-1"
                data-testid={`space-member-picker-${testId}`}
              >
                <div className="px-1 py-0.5 text-xs text-text-dim">
                  {t(I18nKey.SPACE$MEMBERS)}
                </div>
                {conversations.map((conversation) => {
                  const isMember = members[conversation.id] === space.id;
                  const isSharedElsewhere =
                    Boolean(members[conversation.id]) && !isMember;
                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      data-testid={`space-member-option-${conversation.id}`}
                      onClick={() =>
                        void moveConversation(
                          conversation.id,
                          isMember ? null : space.id,
                        )
                      }
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs",
                        "hover:bg-contrast/10",
                        isMember ? "text-contrast" : "text-muted",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "inline-block h-3 w-3 shrink-0 rounded-sm border border-border",
                          isMember && "bg-accent",
                        )}
                      />
                      <span className="truncate">
                        {conversation.title || t(I18nKey.CONVERSATION$UNTITLED)}
                      </span>
                      {isSharedElsewhere ? (
                        <span className="ml-auto shrink-0 text-text-dim">
                          {t(I18nKey.SPACE$MOVED_FROM_OTHER)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {!collapsed ? (
              <div className="mt-0.5 space-y-0.5">
                {visibleMembers.map((conversation) => (
                  <div
                    key={conversation.id}
                    className="group/space-member relative"
                  >
                    {renderConversationCard(conversation)}
                    {members[conversation.id] === space.id ? (
                      <button
                        type="button"
                        aria-label={t(I18nKey.SPACE$MOVE_OUT)}
                        data-testid={`space-move-out-${conversation.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void moveConversation(conversation.id, null);
                        }}
                        className={cn(
                          "absolute right-8 top-1/2 hidden -translate-y-1/2 rounded-md p-1",
                          "text-muted hover:bg-contrast/10 hover:text-contrast",
                          "group-hover/space-member:inline-flex",
                        )}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                ))}
                {visibleMembers.length === 0 ? (
                  <div className="pl-2 text-xs text-text-dim">
                    {t(I18nKey.SPACE$EMPTY)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}

      {draftTitle === null ? (
        <button
          type="button"
          data-testid="space-create"
          onClick={() => setDraftTitle("")}
          className="flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-1 text-sm text-muted transition-colors hover:bg-surface-raised hover:text-contrast"
        >
          <Plus className="h-4 w-4 shrink-0" aria-hidden />
          <span>{t(I18nKey.SPACE$NEW_SPACE)}</span>
        </button>
      ) : (
        <NewSpaceRow
          draftTitle={draftTitle}
          onCommit={(title) => {
            setDraftTitle(null);
            createSpace(title || t(I18nKey.SPACE$UNTITLED));
          }}
          onCancel={() => setDraftTitle(null)}
        />
      )}
    </nav>
  );
}

function NewSpaceRow({
  draftTitle,
  onCommit,
  onCancel,
}: {
  draftTitle: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("openhands");
  return (
    <div className="flex h-8 items-center gap-1 pl-2 pr-1">
      <TitleInput
        autoFocus
        initial={draftTitle}
        placeholder={t(I18nKey.SPACE$NAME_PLACEHOLDER)}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

function TitleInput({
  initial,
  placeholder,
  autoFocus,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  autoFocus?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus={autoFocus}
      value={value}
      placeholder={placeholder}
      data-testid="space-title-input"
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(value.trim());
        if (event.key === "Escape") onCancel();
      }}
      onBlur={() => onCommit(value.trim())}
      className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5 text-sm text-contrast outline-none focus-visible:ring-1 focus-visible:ring-border"
    />
  );
}
