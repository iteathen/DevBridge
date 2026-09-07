export function createChatHandoffRetentionPolicy({ maxRetained }) {
  if (!Number.isSafeInteger(maxRetained) || maxRetained < 2 || maxRetained > 64) throw new TypeError('retention limit is invalid');

  function removals(entries, protectedKeys = []) {
    const keep = new Set(protectedKeys.filter(Boolean));
    const ranked = entries.map(({ key, order }) => ({ key, order })).sort((a, b) => b.order - a.order || a.key.localeCompare(b.key));
    for (const entry of ranked.slice(0, maxRetained)) keep.add(entry.key);
    return ranked.filter((entry) => !keep.has(entry.key)).map((entry) => entry.key);
  }

  return Object.freeze({ removals });
}
