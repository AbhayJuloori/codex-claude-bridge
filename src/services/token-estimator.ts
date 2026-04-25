export function estimateTokensFromText(text: string): number {
  if (!text.trim()) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}
