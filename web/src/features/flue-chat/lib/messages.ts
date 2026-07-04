export function chatMessagesForRender<T>(
  liveMessages: T[],
  canonicalMessages: T[] | undefined,
  status: string,
) {
  return status === 'idle' && canonicalMessages
    ? canonicalMessages
    : liveMessages;
}
