import React from "react";
import type { PassageQuote } from "#/utils/message-quote";
import {
  isProgrammaticSelection,
  messageBubbleFor,
  messageSourceFor,
  readSelection,
  selectionText,
  wholeBlockLines,
} from "#/utils/quote-anchor";

/** A selection that can become a quote, plus where to put the popup. */
export interface QuoteDraft {
  quote: PassageQuote;
  /** Viewport coordinates of the selection's bottom centre. */
  x: number;
  y: number;
}

/**
 * Turns a mouse selection inside one chat message into a quote draft.
 *
 * Rules, in Devin's shape: the selection must be non-collapsed and inside a
 * single message bubble; buttons inside the bubble are cut out of it; our own
 * highlight (from clicking a quote card) is ignored; a selection inside the
 * quote popup or composer pill is not a selection at all.
 *
 * Listeners sit on the document rather than on a feed wrapper, because the only
 * elements that can start a quote carry `data-message-event-id`, and a wrapper
 * around the conversation view would mean a new layout box in the chat panel.
 */
export function useMessageSelection(): {
  draft: QuoteDraft | null;
  dismiss: () => void;
} {
  const [draft, setDraft] = React.useState<QuoteDraft | null>(null);

  React.useEffect(() => {
    const isQuoteUi = (target: EventTarget | null) =>
      target instanceof Element && target.closest("[data-quote-ui]") !== null;

    const onPointerUp = (event: PointerEvent) => {
      if (isQuoteUi(event.target)) return;
      const selection = readSelection();
      if (!selection || isProgrammaticSelection(selection)) return;

      const range = selection.getRangeAt(0);
      const quote = quoteFromRange(range);
      if (!quote) {
        setDraft(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setDraft({ quote, x: rect.left + rect.width / 2, y: rect.bottom + 6 });
    };

    // Anything the user touches next closes the popup: a new selection reopens
    // it on the same gesture's pointerup, a click anywhere else leaves it closed.
    const onPointerDown = (event: PointerEvent) => {
      if (!isQuoteUi(event.target)) setDraft(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDraft(null);
      window.getSelection()?.removeAllRanges();
    };

    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const dismiss = React.useCallback(() => {
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  return { draft, dismiss };
}

/**
 * The quote a range means, or null when it is not quotable. Whole blocks are
 * quoted from the markdown source (a selected list keeps its `-`, a code block
 * its fences); a partial selection is quoted as the text the user saw.
 */
export function quoteFromRange(range: Range): PassageQuote | null {
  if (range.collapsed) return null;
  const bubble = messageBubbleFor(range.startContainer, document.body);
  if (
    !bubble ||
    bubble !== messageBubbleFor(range.endContainer, document.body)
  ) {
    return null;
  }

  const source = messageSourceFor(bubble) ?? "";
  const whole = source ? wholeBlockLines(range, source) : null;
  const content = (whole?.content ?? selectionText(range)).trim();
  const eventId = bubble.dataset.messageEventId ?? "";
  if (!content || !eventId) return null;

  return {
    eventId,
    author: bubble.dataset.messageAuthor === "user" ? "user" : "agent",
    caption: "",
    content,
    startLine: whole?.start,
    endLine: whole?.end,
    truncated: false,
  };
}
