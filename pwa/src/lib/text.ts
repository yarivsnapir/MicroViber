/** First sentence (or line) of text, capped for compact subtitle display. */
export function firstSentence(text: string, maxLen = 80): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const newline = trimmed.indexOf('\n');
  const sentenceEnd = trimmed.search(/[.!?](\s|$)/);

  let end = trimmed.length;
  if (newline !== -1) end = Math.min(end, newline);
  if (sentenceEnd !== -1) end = Math.min(end, sentenceEnd + 1);

  const cut = trimmed.slice(0, end).trim();
  if (cut.length <= maxLen) return cut;
  return `${cut.slice(0, maxLen - 1).trim()}…`;
}
