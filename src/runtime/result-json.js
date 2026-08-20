function unwrapSingleJsonFence(text) {
  const match = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  return match ? match[1].trim() : text;
}

export function parseResultJsonText(value) {
  let normalized = String(value);
  if (normalized.charCodeAt(0) === 0xFEFF) normalized = normalized.slice(1);
  return JSON.parse(unwrapSingleJsonFence(normalized.trim()));
}
