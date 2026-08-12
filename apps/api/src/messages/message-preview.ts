export const MAX_MESSAGE_PREVIEW_CODE_POINTS = 120;

export function messagePreview(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= MAX_MESSAGE_PREVIEW_CODE_POINTS) return text;
  return `${codePoints
    .slice(0, MAX_MESSAGE_PREVIEW_CODE_POINTS - 1)
    .join('')}…`;
}
