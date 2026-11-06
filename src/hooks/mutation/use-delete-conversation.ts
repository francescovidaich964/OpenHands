import { getActiveBackend } from "#/api/backend-registry/active-store";
import {
  sessionActivityKey,
  useSessionActivityStore,
} from "#/stores/session-activity-store";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import type { AcpSessionDeleteOutcome } from "#/api/conversation-service/agent-server-conversation-service.types";
import { clearConversationLocalStorage } from "#/utils/conversation-local-storage";
import i18n from "#/i18n";
import { I18nKey } from "#/i18n/declaration";
import {
  displaySuccessToast,
  displayWarningToast,
} from "#/utils/custom-toast-handlers";

interface DeleteConversationVariables {
  conversationId: string;
  /**
   * False for "delete all", which reports one aggregate result instead of a
   * notice per conversation.
   */
  agentSessionToast?: boolean;
}

export const useDeleteConversation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: DeleteConversationVariables) => {
      const { backend, orgId } = getActiveBackend();
      const result = await AgentServerConversationService.deleteConversation(
        variables.conversationId,
      );
      useSessionActivityStore
        .getState()
        .remove(
          sessionActivityKey(backend.id, orgId, variables.conversationId),
        );
      return result;
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["user", "conversations"] });
      const previousConversations = queryClient.getQueryData([
        "user",
        "conversations",
      ]);

      queryClient.setQueryData(
        ["user", "conversations"],
        (old: { conversation_id: string }[] | undefined) =>
          old?.filter(
            (conv) => conv.conversation_id !== variables.conversationId,
          ),
      );

      return { previousConversations };
    },

    onSuccess: (
      outcome: AcpSessionDeleteOutcome | null,
      variables: DeleteConversationVariables,
    ) => {
      clearConversationLocalStorage(variables.conversationId);
      // Say out loud when the conversation is gone but the agent kept its own
      // session (#40). No outcome at all is the honest normal case: a cloud
      // conversation, an agent without session/delete, an older agent-server.
      if (!outcome || variables.agentSessionToast === false) {
        return;
      }
      if (outcome.acp_session_deleted) {
        displaySuccessToast(
          i18n.t(I18nKey.CONVERSATION$DELETE_AGENT_SESSION_SUCCESS),
        );
      } else {
        displayWarningToast(
          i18n.t(I18nKey.CONVERSATION$DELETE_AGENT_SESSION_FAILED, {
            error: outcome.acp_session_delete_error ?? "",
          }),
        );
      }
    },

    onError: (err, variables, context) => {
      if (context?.previousConversations) {
        queryClient.setQueryData(
          ["user", "conversations"],
          context.previousConversations,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["user", "conversations"] });
      // Mirror useCreateConversation: cloud surfaces in-flight
      // conversations via useStartTasks, so invalidate that key too so the
      // panel refreshes regardless of whether the deleted item was a ready
      // conversation or a still-provisioning start task.
      queryClient.invalidateQueries({ queryKey: ["start-tasks"] });
    },
  });
};
