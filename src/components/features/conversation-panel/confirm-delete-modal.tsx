import React from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  BaseModalDescription,
  BaseModalTitle,
} from "#/components/shared/modals/confirmation-modals/base-modal";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import { ModalBody } from "#/components/shared/modals/modal-body";
import { BrandButton } from "../settings/brand-button";
import { I18nKey } from "#/i18n/declaration";
import { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";

interface ConfirmDeleteModalProps {
  onConfirm: () => void;
  onCancel: () => void;
  conversationTitle?: string;
  title?: string;
  description?: React.ReactNode;
  /**
   * Kind of the deleted conversation's agent. `acp` adds the line explaining
   * that the agent's own session (opencode's session store, a Claude Code
   * transcript) goes with the conversation, because that copy is outside
   * OpenHands' data and the user cannot see it in the app (#40).
   */
  agentKind?: AppConversation["agent_kind"];
}

export function ConfirmDeleteModal({
  onConfirm,
  onCancel,
  conversationTitle,
  title,
  description,
  agentKind,
}: ConfirmDeleteModalProps) {
  const { t } = useTranslation("openhands");

  let confirmationMessage: React.ReactNode;
  if (description != null) {
    confirmationMessage = description;
  } else if (conversationTitle) {
    confirmationMessage = (
      <Trans
        ns="openhands"
        i18nKey={I18nKey.CONVERSATION$DELETE_WARNING_WITH_TITLE}
        values={{ title: conversationTitle }}
        components={{ title: <span className="text-contrast" /> }}
      />
    );
  } else {
    confirmationMessage = t(I18nKey.CONVERSATION$DELETE_WARNING);
  }

  return (
    <ModalBackdrop onClose={onCancel}>
      <ModalBody className="items-start border border-border">
        <div className="flex flex-col gap-2">
          <BaseModalTitle
            title={title ?? t(I18nKey.CONVERSATION$CONFIRM_DELETE)}
          />
          <BaseModalDescription>{confirmationMessage}</BaseModalDescription>
          {/* The agent-side capability is not part of the conversation record, so
              every ACP conversation gets the note and its wording is conditional
              on the agent supporting `session/delete`. */}
          {agentKind === "acp" && (
            <BaseModalDescription>
              <span data-testid="agent-session-delete-note">
                {t(I18nKey.CONVERSATION$DELETE_AGENT_SESSION_NOTE)}
              </span>
            </BaseModalDescription>
          )}
        </div>
        <div
          className="flex justify-end gap-2 w-full"
          onClick={(event) => event.stopPropagation()}
        >
          <BrandButton
            type="button"
            variant="secondary"
            onClick={onCancel}
            testId="cancel-button"
          >
            {t(I18nKey.BUTTON$CANCEL)}
          </BrandButton>
          <BrandButton
            type="button"
            variant="primary"
            onClick={onConfirm}
            testId="confirm-button"
          >
            {t(I18nKey.ACTION$CONFIRM_DELETE)}
          </BrandButton>
        </div>
      </ModalBody>
    </ModalBackdrop>
  );
}
