import type { SessionId } from '@deepseek-ai/dsh-session'

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/

/**
 * Refuse a session id that cannot be one S3 key segment.
 * @param id - the stored session identity.
 */
export function assertSessionKey(id: SessionId): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new TypeError(`session id ${JSON.stringify(id)} is not usable as an S3 key segment`)
  }
}

/**
 * Normalize a configured prefix: no leading slash, trailing slash when non-empty.
 * @param prefix - the configured key prefix.
 * @returns the normalized prefix.
 */
export function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? '').replace(/^\/+/, '')
  if (trimmed === '') return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * Root key containing every session directory.
 * @param prefix - the normalized key prefix.
 * @returns the sessions root key.
 */
export function sessionsRoot(prefix: string): string {
  return `${prefix}sessions/`
}

/**
 * Base key of one stored session.
 * @param prefix - the normalized key prefix.
 * @param id - the stored session identity.
 * @returns the session directory key.
 */
export function sessionBase(prefix: string, id: SessionId): string {
  return `${sessionsRoot(prefix)}${id}/`
}

/**
 * Manifest object key for one session.
 * @param prefix - the normalized key prefix.
 * @param id - the stored session identity.
 * @returns the manifest object key.
 */
export function manifestKey(prefix: string, id: SessionId): string {
  return `${sessionBase(prefix, id)}manifest.json`
}

/**
 * Fragment object key for one immutable event batch.
 * @param prefix - the normalized key prefix.
 * @param id - the stored session identity.
 * @param name - the fragment file name recorded in the manifest.
 * @returns the fragment object key.
 */
export function fragmentKey(prefix: string, id: SessionId, name: string): string {
  return `${sessionBase(prefix, id)}fragments/${name}`
}

/**
 * Write-lease object key for one session.
 * @param prefix - the normalized key prefix.
 * @param id - the stored session identity.
 * @returns the lease object key.
 */
export function leaseKey(prefix: string, id: SessionId): string {
  return `${sessionBase(prefix, id)}lease.json`
}

/**
 * Immutable fragment file name: first sequence plus a content digest prefix.
 * @param firstSeq - the first event sequence contained in the fragment.
 * @param sha256 - the fragment body's SHA-256.
 * @returns the fragment file name.
 */
export function fragmentName(firstSeq: number, sha256: string): string {
  return `${String(firstSeq).padStart(8, '0')}-${sha256.slice(0, 16)}.jsonl`
}

/**
 * Recover the session id from one listed session directory prefix.
 * @param root - the sessions root key.
 * @param prefix - one common prefix returned by the bucket listing.
 * @returns the session id, or `undefined` for a nested or unrelated prefix.
 */
export function idFromSessionPrefix(root: string, prefix: string): string | undefined {
  if (!prefix.startsWith(root) || !prefix.endsWith('/')) return undefined
  const id = prefix.slice(root.length, -1)
  if (id === '' || id.includes('/')) return undefined
  return id
}
