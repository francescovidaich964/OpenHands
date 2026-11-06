import { useTranslation } from "react-i18next";
import { ExecutionStatus } from "#/types/agent-server/core/base/common";
import { SandboxStatus } from "#/api/conversation-service/agent-server-conversation-service.types";
import { I18nKey } from "#/i18n/declaration";
import { isMissingSandboxStatus } from "#/utils/conversation-archive-status";
import { ConversationCardTitle } from "./conversation-card-title";
import { ConversationStatusDot } from "../conversation-status-dot";

interface ConversationCardHeaderProps {
  title: string;
  titlePending?: boolean;
  titleMode: "view" | "edit";
  onTitleSave: (title: string) => void;
  executionStatus?: ExecutionStatus | null;
  isStarting?: boolean;
  sandboxStatus?: SandboxStatus | null;
  /**
   * The row's effective archived state (explicit archive or missing runtime).
   * Dims the title and grays the status dot so both agree with the "Archived"
   * chip. Defaults to the runtime-derived case for callers that only know the
   * sandbox status.
   */
  isArchived?: boolean;
  /**
   * Marks a conversation with agent output the user has not opened yet. Its own
   * channel: it sits next to the title, never replacing the execution-status
   * dot, so "running" and "unread" can show at the same time.
   */
  isUnread?: boolean;
}

export function ConversationCardHeader({
  title,
  titlePending,
  titleMode,
  onTitleSave,
  executionStatus,
  isStarting,
  sandboxStatus,
  isArchived,
  isUnread,
}: ConversationCardHeaderProps) {
  const { t } = useTranslation("openhands");
  const archived = isArchived ?? isMissingSandboxStatus(sandboxStatus);
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
      {(executionStatus !== undefined || isStarting) && (
        <div className="flex w-4.5 shrink-0 items-center justify-center">
          <ConversationStatusDot
            executionStatus={executionStatus}
            isStarting={isStarting}
            sandboxStatus={sandboxStatus}
            isArchived={archived}
            showTooltip={false}
          />
        </div>
      )}
      <ConversationCardTitle
        title={title}
        titlePending={titlePending}
        titleMode={titleMode}
        onSave={onTitleSave}
        isConversationArchived={archived}
      />
      {isUnread && (
        <span
          data-testid="conversation-unread-dot"
          role="img"
          aria-label={t(I18nKey.CONVERSATION$UNREAD)}
          className="size-1.5 shrink-0 rounded-full bg-accent"
        />
      )}
    </div>
  );
}
