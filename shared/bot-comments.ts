export const botCommentPrefix = 'bot:';

export function prefixBotComment(body: string) {
  const trimmed = body.trim();
  return trimmed.startsWith(botCommentPrefix)
    ? trimmed
    : `${botCommentPrefix} ${trimmed}`;
}
