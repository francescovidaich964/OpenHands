import ActionType from "#/types/action-type";

export function createChatMessage(
  message: string,
  image_urls: string[],
  file_urls: string[],
  timestamp: string,
  /**
   * Sent as further text parts after `message`, in order. A passage quote
   * travels here so the envelope stays its own part, the way Devin sends it.
   */
  extra_text_parts: string[] = [],
) {
  const event = {
    action: ActionType.MESSAGE,
    args: {
      content: message,
      image_urls,
      file_urls,
      timestamp,
      extra_text_parts,
    },
  };
  return event;
}
