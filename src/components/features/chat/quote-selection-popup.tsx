import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

/** Where the popup sits, in viewport coordinates, next to the selection. */
export interface QuotePopupPosition {
  x: number;
  y: number;
}

interface QuoteSelectionPopupProps {
  position: QuotePopupPosition;
  /** Existing caption when the popup is re-opened to edit a staged quote. */
  initialCaption?: string;
  /** True while editing a quote that is already staged: the button says Save. */
  isEditing?: boolean;
  onSave: (caption: string) => void;
  /** Send the comment about this passage now (Enter, "Add to chat"). */
  onSend: (caption: string) => void;
  /** Collapse into the composer pill instead of sending (Escape). */
  onStage: (caption: string) => void;
}

const WIDTH_PX = 288;
const HEIGHT_PX = 92;

/**
 * The floating card Devin shows over a selection: one caption field. Enter or
 * "Add to chat" sends the comment about that passage immediately; Escape or
 * "Add to composer" collapses it into the composer as a staged quote, to send
 * with the next regular message. Editing a staged quote reuses this card with
 * "Save".
 */
export function QuoteSelectionPopup({
  position,
  initialCaption,
  isEditing,
  onSave,
  onSend,
  onStage,
}: QuoteSelectionPopupProps) {
  const { t } = useTranslation();
  const [caption, setCaption] = React.useState(initialCaption ?? "");
  const fieldRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  // Keep the card on screen: Devin flips it above the selection near the
  // bottom of the window and clamps it inside the feed horizontally.
  const left = Math.max(
    8,
    Math.min(position.x, window.innerWidth - WIDTH_PX - 8),
  );
  const below = position.y + HEIGHT_PX + 12 < window.innerHeight;
  const top = below ? position.y + 6 : position.y - HEIGHT_PX - 10;

  return (
    <div
      data-testid="quote-selection-popup"
      data-quote-ui=""
      data-quote-exclude=""
      role="dialog"
      aria-label={t(I18nKey.CHAT_INTERFACE$QUOTE_ADD_CAPTION)}
      className="fixed z-50 w-72 rounded-md border border-contrast bg-base-secondary shadow-lg p-2"
      style={{ left, top }}
    >
      <input
        ref={fieldRef}
        value={caption}
        data-testid="quote-caption-input"
        placeholder={t(
          isEditing
            ? I18nKey.CHAT_INTERFACE$QUOTE_START_TYPING
            : I18nKey.CHAT_INTERFACE$QUOTE_ADD_CAPTION,
        )}
        onChange={(event) => setCaption(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (isEditing) onSave(caption);
            else onSend(caption);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onStage(caption);
          }
        }}
        className="w-full rounded border border-contrast/30 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="quote-stage-button"
          onClick={() => onStage(caption)}
          className="text-xs text-muted hover:text-contrast"
        >
          {t(I18nKey.CHAT_INTERFACE$QUOTE_STAGE)}
        </button>
        <button
          type="button"
          data-testid="quote-primary-button"
          onClick={() => (isEditing ? onSave(caption) : onSend(caption))}
          className={cn("rounded bg-primary px-2 py-1 text-xs text-white")}
        >
          {isEditing
            ? t(I18nKey.CHAT_INTERFACE$QUOTE_SAVE)
            : t(I18nKey.CHAT_INTERFACE$QUOTE_ADD_TO_CHAT)}
        </button>
      </div>
    </div>
  );
}
