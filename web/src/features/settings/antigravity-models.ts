/** Preserve per-model settings when an administrator only edits the ID list. */
export function antigravityModelsFromIds(previous: unknown, text: string) {
  const models = new Map<string, string | Record<string, unknown>>()
  if (Array.isArray(previous)) {
    for (const item of previous) {
      if (typeof item === 'string') models.set(item, item)
      else if (item && typeof item === 'object' && typeof item.id === 'string')
        models.set(item.id, item)
    }
  }
  return [
    ...new Set(
      text
        .split('\n')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ].map((id) => models.get(id) || id)
}
