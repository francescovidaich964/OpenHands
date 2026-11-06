import { create } from "zustand";
import type { PassageQuote } from "#/utils/message-quote";

/**
 * A passage quote the user staged with the selection popup's Escape path: it
 * travels with the NEXT message they send, the way a reply quote does, but it
 * is a sub-message passage rather than a whole message.
 *
 * Keyed by conversation, like the reply-quote store, so switching conversations
 * cannot carry a quote across. `editing` is the popup's edit target: the pill
 * asks for the popup to reopen at its own position.
 */
interface PendingQuoteState {
  staged: Record<string, PassageQuote | undefined>;
  editing: { conversationId: string; x: number; y: number } | null;
  stage: (conversationId: string, quote: PassageQuote) => void;
  discard: (conversationId: string) => void;
  beginEdit: (conversationId: string, x: number, y: number) => void;
  endEdit: () => void;
}

export const usePendingQuoteStore = create<PendingQuoteState>((set) => ({
  staged: {},
  editing: null,
  stage: (conversationId, quote) =>
    set((state) => ({
      staged: { ...state.staged, [conversationId]: quote },
      editing: null,
    })),
  discard: (conversationId) =>
    set((state) => {
      const { [conversationId]: _removed, ...rest } = state.staged;
      return { staged: rest };
    }),
  beginEdit: (conversationId, x, y) =>
    set({ editing: { conversationId, x, y } }),
  endEdit: () => set({ editing: null }),
}));

/** Staged quote for a conversation, read outside React (submit handlers). */
export const readStagedQuote = (conversationId?: string) =>
  conversationId
    ? (usePendingQuoteStore.getState().staged[conversationId] ?? null)
    : null;

/** The staged quote for a conversation, subscribed to React renders. */
export const usePendingQuote = (conversationId: string) =>
  usePendingQuoteStore((state) =>
    conversationId ? state.staged[conversationId] : undefined,
  );
