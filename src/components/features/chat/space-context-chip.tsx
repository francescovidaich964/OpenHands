import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSpaceSummaries } from "#/hooks/use-space-summaries";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

export interface SpaceContextChipProps {
  conversationId: string | null | undefined;
}

/**
 * Composer chip for a conversation that belongs to a space (fork feature):
 * what its first message will carry. Devin's strings are the reference —
 * "Summarizing parent session…", "Includes context from parent: …", and the
 * failure notice that says the conversation starts without it.
 *
 * It disappears after the first send: the block is a first-message thing.
 */
export function SpaceContextChip({ conversationId }: SpaceContextChipProps) {
  const { t } = useTranslation("openhands");
  const { spaceId, spaceTitle, isSummarizing, failed, willIncludeContext } =
    useSpaceSummaries(conversationId);

  if (!spaceId || !willIncludeContext) return null;

  const label = failed
    ? t(I18nKey.SPACE$UNAVAILABLE)
    : isSummarizing
      ? t(I18nKey.SPACE$SUMMARIZING)
      : t(I18nKey.SPACE$INCLUDED_FROM, {
          title: spaceTitle || t(I18nKey.SPACE$UNTITLED),
        });

  return (
    <div
      data-testid="space-context-chip"
      className="flex items-start gap-1.5 px-1 pb-1 text-xs"
    >
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border px-2 py-0.5",
          failed ? "text-warning" : "text-text-dim",
        )}
        title={label}
      >
        {isSummarizing && !failed ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        ) : failed ? (
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span className="truncate">{label}</span>
      </span>
    </div>
  );
}
