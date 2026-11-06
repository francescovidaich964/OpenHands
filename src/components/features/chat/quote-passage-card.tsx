import React from "react";
import { flashMessage, selectQuotedPassage } from "#/utils/quote-anchor";
import { QuoteCard } from "./quote-card";
import type { PassageQuote } from "#/utils/message-quote";

interface QuotePassageCardProps {
  quote: PassageQuote;
  /** Composer variant: clicking edits the staged quote instead of jumping. */
  onEdit?: () => void;
  onDismiss?: () => void;
}

/**
 * A selected passage, shown in a message bubble, in the composer pill and in the
 * pending-message row. The card from the reply-quote work already draws the
 * source label, body and truncation flag; what a passage adds is the caption
 * (what the user said about it) and a jump that highlights the passage itself,
 * not just the message around it.
 */
export function QuotePassageCard({
  quote,
  onEdit,
  onDismiss,
}: QuotePassageCardProps) {
  const jumpToPassage = React.useCallback(() => {
    const bubble = document.querySelector<HTMLElement>(
      `[data-message-event-id="${CSS.escape(quote.eventId)}"]`,
    );
    if (!bubble) return; // the source scrolled out of the loaded window
    selectQuotedPassage(bubble, quote.content, quote.startLine, quote.endLine);
    flashMessage(bubble); // scrolls the message into view and highlights it
  }, [quote.eventId, quote.content, quote.startLine, quote.endLine]);

  return (
    <div
      className="flex flex-col gap-1"
      data-quote-ui
      data-testid="quote-passage-card"
    >
      <QuoteCard
        quote={{
          sourceEventId: quote.eventId,
          source: quote.author,
          body: quote.content,
          truncated: quote.truncated,
        }}
        onJump={onEdit ?? jumpToPassage}
        onDismiss={onDismiss}
      />
      {quote.caption.trim() && (
        <span className="pl-1 text-xs text-muted">{quote.caption}</span>
      )}
    </div>
  );
}
