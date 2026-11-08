import type { SessionEvent } from '@deepseek-ai/dsh-session'

function deepFreeze(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (!Object.isFrozen(value)) Object.freeze(value)
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen)
  }
}

/**
 * Deep-freeze one event so persisted and live handles can share it safely.
 * @param event - the validated event to freeze in place.
 * @returns the same event.
 */
export function freezeSessionEvent<T extends SessionEvent>(event: T): T {
  deepFreeze(event, new Set())
  return event
}
