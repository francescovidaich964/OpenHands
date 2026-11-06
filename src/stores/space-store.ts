import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { spaceIdFromTags } from "#/utils/space-tags";

/**
 * Spaces (fork feature): user-created folders of conversations whose new
 * conversations start with a summary of the other members — the Canvas
 * equivalent of Devin's spaces (see `src/utils/space-context.ts`).
 *
 * Split-brain on purpose:
 *   - **membership** also lives on the conversation itself as the
 *     `canvasspace=<spaceId>` tag (`src/utils/space-tags.ts`), so it survives a
 *     different device; `syncMembershipFromTags` folds those tags back in.
 *   - **titles, order, summaries** are Canvas-local: the backend has nowhere to
 *     put them. shortcut: a space title seen on device A shows on device B as
 *     an untitled space with the same members; upgrade by storing space
 *     objects server-side next to the tag.
 *
 * Summaries are keyed by conversation id (Devin keeps one `.md` file per
 * session the same way) and carry `messageCount` so the next refresh only
 * sends the new messages.
 */
export interface Space {
  id: string;
  title: string;
  createdAt: string;
}

export interface SpaceSummary {
  summary: string;
  /** Conversation messages this digest covers; the incremental-refresh cursor. */
  messageCount: number;
  updatedAt: string;
}

/** Minimal shape `syncMembershipFromTags` needs from the conversation list. */
export interface TaggedConversation {
  id: string;
  title?: string | null;
  tags?: Record<string, string> | null;
}

interface SpaceStoreState {
  spaces: Record<string, Space>;
  /** Space ids in display order; spaces missing from it sort last. */
  spaceOrder: string[];
  /** conversation id -> space id (local mirror of the `canvasspace` tag). */
  members: Record<string, string>;
  /** conversation id -> title, for the `<session title="…">` attribute. */
  titles: Record<string, string>;
  /** conversation id -> its digest. */
  summaries: Record<string, SpaceSummary>;
  /** Conversations whose first message already carried the space context. */
  contextInjected: Record<string, true>;
  collapsedSpaceIds: string[];
}

interface SpaceStoreActions {
  /** Creates a space and returns its id ("" title renders as untitled). */
  createSpace: (title: string) => string;
  renameSpace: (spaceId: string, title: string) => void;
  /** Forgets the space; its conversations are left alone (Devin's rule). */
  deleteSpace: (spaceId: string) => void;
  /** Moves a conversation into `spaceId` (null moves it out). */
  assignSpace: (conversationId: string, spaceId: string | null) => void;
  setSpaceOrder: (order: readonly string[]) => void;
  toggleSpaceCollapsed: (spaceId: string) => void;
  rememberConversationTitle: (conversationId: string, title: string) => void;
  setSummary: (
    conversationId: string,
    summary: string,
    messageCount: number,
  ) => void;
  markContextInjected: (conversationId: string) => void;
  /**
   * Folds server-side `canvasspace` tags into the local mirror. The server wins
   * for any conversation the caller actually listed; conversations the list
   * does not contain keep whatever the local store says.
   */
  syncMembershipFromTags: (conversations: TaggedConversation[]) => void;
}

type SpaceStore = SpaceStoreState & SpaceStoreActions;

const initialState: SpaceStoreState = {
  spaces: {},
  spaceOrder: [],
  members: {},
  titles: {},
  summaries: {},
  contextInjected: {},
  collapsedSpaceIds: [],
};

/** Same shape Devin's old space ids had: creation ms plus a random suffix. */
function newSpaceId(): string {
  return `space-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export const useSpaceStore = create<SpaceStore>()(
  persist(
    (set) => ({
      ...initialState,

      createSpace: (title) => {
        const id = newSpaceId();
        set((state) => ({
          spaces: {
            ...state.spaces,
            [id]: {
              id,
              title: title.trim(),
              createdAt: new Date().toISOString(),
            },
          },
          spaceOrder: [...state.spaceOrder, id],
        }));
        return id;
      },

      renameSpace: (spaceId, title) =>
        set((state) => {
          const space = state.spaces[spaceId];
          if (!space) return state;
          return {
            spaces: {
              ...state.spaces,
              [spaceId]: { ...space, title: title.trim() },
            },
          };
        }),

      deleteSpace: (spaceId) =>
        set((state) => {
          const spaces = { ...state.spaces };
          delete spaces[spaceId];
          const members: Record<string, string> = {};
          for (const [conversationId, candidate] of Object.entries(
            state.members,
          )) {
            if (candidate !== spaceId) members[conversationId] = candidate;
          }
          return {
            spaces,
            members,
            spaceOrder: state.spaceOrder.filter((id) => id !== spaceId),
            collapsedSpaceIds: state.collapsedSpaceIds.filter(
              (id) => id !== spaceId,
            ),
          };
        }),

      assignSpace: (conversationId, spaceId) =>
        set((state) => {
          const members = { ...state.members };
          if (spaceId) {
            members[conversationId] = spaceId;
          } else {
            delete members[conversationId];
          }
          return { members };
        }),

      setSpaceOrder: (order) => set(() => ({ spaceOrder: [...order] })),

      toggleSpaceCollapsed: (spaceId) =>
        set((state) => ({
          collapsedSpaceIds: state.collapsedSpaceIds.includes(spaceId)
            ? state.collapsedSpaceIds.filter((id) => id !== spaceId)
            : [...state.collapsedSpaceIds, spaceId],
        })),

      rememberConversationTitle: (conversationId, title) =>
        set((state) => {
          // A blank title would render `<session title="" />`; keep the id instead.
          if (!title.trim() || state.titles[conversationId] === title)
            return state;
          return { titles: { ...state.titles, [conversationId]: title } };
        }),

      setSummary: (conversationId, summary, messageCount) =>
        set((state) => ({
          summaries: {
            ...state.summaries,
            [conversationId]: {
              summary,
              messageCount,
              updatedAt: new Date().toISOString(),
            },
          },
        })),

      markContextInjected: (conversationId) =>
        set((state) => ({
          contextInjected: { ...state.contextInjected, [conversationId]: true },
        })),

      syncMembershipFromTags: (conversations) =>
        set((state) => {
          let members = state.members;
          let spaces = state.spaces;
          let titles = state.titles;
          let changed = false;

          for (const conversation of conversations) {
            const spaceId = spaceIdFromTags(conversation.tags);
            if (
              conversation.title &&
              state.titles[conversation.id] !== conversation.title
            ) {
              titles = { ...titles, [conversation.id]: conversation.title };
              changed = true;
            }
            if ((state.members[conversation.id] ?? null) === spaceId) {
              continue;
            }
            members = { ...members };
            if (spaceId) {
              members[conversation.id] = spaceId;
              // A tag from another device: keep the member visible by giving
              // the unknown space an (untitled) record.
              if (!spaces[spaceId]) {
                spaces = {
                  ...spaces,
                  [spaceId]: {
                    id: spaceId,
                    title: "",
                    createdAt: new Date().toISOString(),
                  },
                };
              }
            } else {
              delete members[conversation.id];
            }
            changed = true;
          }

          return changed ? { members, spaces, titles } : state;
        }),
    }),
    {
      name: "spaces",
      storage: createJSONStorage(() => localStorage),
      // Only persist the data fields — actions are recreated on each load.
      partialize: (state): SpaceStoreState => ({
        spaces: state.spaces,
        spaceOrder: state.spaceOrder,
        members: state.members,
        titles: state.titles,
        summaries: state.summaries,
        contextInjected: state.contextInjected,
        collapsedSpaceIds: state.collapsedSpaceIds,
      }),
    },
  ),
);

/** Member conversation ids of a space, in insertion order. */
export function selectSpaceMemberIds(
  state: Pick<SpaceStoreState, "members">,
  spaceId: string,
): string[] {
  return Object.entries(state.members)
    .filter(([, candidate]) => candidate === spaceId)
    .map(([conversationId]) => conversationId);
}

/** Spaces in display order (unknown-order spaces keep their creation order). */
export function selectOrderedSpaces(
  state: Pick<SpaceStoreState, "spaces" | "spaceOrder">,
): Space[] {
  const known = state.spaceOrder
    .map((id) => state.spaces[id])
    .filter((space): space is Space => Boolean(space));
  const rest = Object.values(state.spaces)
    .filter((space) => !state.spaceOrder.includes(space.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [...known, ...rest];
}
