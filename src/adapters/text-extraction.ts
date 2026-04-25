function extractFromArray(values: unknown[]): string {
  return values.map((value) => extractText(value)).join("");
}

export function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    return extractFromArray(value);
  }

  const record = value as Record<string, unknown>;

  if (typeof record.delta === "string") {
    return record.delta;
  }

  if (record.delta) {
    const nestedDelta = extractText(record.delta);
    if (nestedDelta) {
      return nestedDelta;
    }
  }

  if (typeof record.text === "string") {
    return record.text;
  }

  if (Array.isArray(record.content)) {
    const contentText = extractFromArray(record.content);
    if (contentText) {
      return contentText;
    }
  }

  if (Array.isArray(record.text_elements)) {
    const textElements = extractFromArray(record.text_elements);
    if (textElements) {
      return textElements;
    }
  }

  if (record.item) {
    return extractText(record.item);
  }

  return "";
}
