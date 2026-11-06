import { useCallback } from "react";
import { useConversationWebSocket } from "#/contexts/conversation-websocket-context";
import { useOptionalConversationId } from "#/hooks/use-conversation-id";
import { MessageContent } from "#/api/conversation-service/agent-server-conversation-service.types";
import { spaceContextForFirstMessage } from "#/utils/space-send-context";
import { useSpaceStore } from "#/stores/space-store";

interface SendResult {
  queued: boolean; // true if message was queued for later delivery
}

/**
 * Sends user messages through the active conversation WebSocket.
 */
export function useSendMessage() {
  // Optional: this hook is reachable from the home-page chat input shell.
  // Outside a conversation route, `conversationContext` is null anyway so
  // `send` is a no-op that returns `{ queued: false }`.
  const { conversationId } = useOptionalConversationId();

  // Get agent-server context (null outside a conversation provider)
  const conversationContext = useConversationWebSocket();

  const send = useCallback(
    async (event: Record<string, unknown>): Promise<SendResult> => {
      if (conversationContext) {
        // Convert chat input payloads to agent-server message content.
        const { action, args } = event as {
          action: string;
          args?: {
            content?: string;
            image_urls?: string[];
            file_urls?: string[];
            timestamp?: string;
          };
        };

        if (action === "message" && args?.content) {
          // Build agent-server message content array
          const content: Array<MessageContent> = [
            {
              type: "text",
              text: args.content,
            },
          ];

          // Add images if present - using SDK's ImageContent format
          if (args.image_urls && args.image_urls.length > 0) {
            content.push({
              type: "image",
              image_urls: args.image_urls,
            });
          }

          // Fork feature (Spaces, Devin parity): the FIRST user message of a
          // conversation that belongs to a space carries the space's other
          // summaries as their own text part, in front of the user's text.
          const spaceContext = spaceContextForFirstMessage(conversationId);
          if (spaceContext) {
            content.unshift({ type: "text", text: spaceContext.text });
          }

          // Send via WebSocket context (uses correct host/port)
          const result = await conversationContext.sendMessage({
            role: "user",
            content,
          });
          if (spaceContext && conversationId) {
            // Only once it is really sent, so a failed send can still deliver
            // the context on the retry.
            useSpaceStore.getState().markContextInjected(conversationId);
          }
          return result;
        }
        return { queued: false };
      }
      return { queued: false };
    },
    [conversationContext, conversationId],
  );

  return { send };
}
