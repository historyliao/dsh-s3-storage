import { createHash } from 'node:crypto'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'

/** Manifest framing version written by this backend. */
export const MANIFEST_FORMAT = 1 as const

const FRAGMENT_NAME = /^\d{8}-[0-9a-f]{16}\.jsonl$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const ORIGINS = new Set(['subagent'])

/** One immutable fragment listed by the manifest. */
export interface FragmentRef {
  /** Fragment file name under the session's `fragments/` key prefix. */
  readonly name: string
  /** First event sequence contained in the fragment. */
  readonly firstSeq: number
  /** Number of events contained in the fragment. */
  readonly count: number
  /** SHA-256 of the fragment body. */
  readonly sha256: string
  /** Fragment body byte length. */
  readonly bytes: number
}

/** The single commit point of one stored session. */
export interface SessionManifest {
  /** Manifest framing version. */
  readonly format: typeof MANIFEST_FORMAT
  /** Session identity. */
  readonly id: SessionIdType
  /** Immutable logical header fixed at create. */
  readonly header: SessionHeader
  /** Fork-inherited prefix length stored beside the header. */
  readonly inheritedEventCount: number
  /** Monotonic commit counter; write-ownership churn never changes it. */
  readonly revision: number
  /** Committed fragments in log order. */
  readonly fragments: readonly FragmentRef[]
  /** Unix epoch milliseconds of the last commit. */
  readonly updatedAt: number
}

/** Encoded event batch ready for one immutable object write. */
export interface EncodedFragment {
  /** UTF-8 JSONL body. */
  readonly body: string
  /** SHA-256 of {@link body}. */
  readonly sha256: string
  /** Byte length of {@link body}. */
  readonly bytes: number
}

function corruption(id: SessionIdType, detail: string, cause?: unknown): SessionPersistenceCorruptionError {
  return new SessionPersistenceCorruptionError(`session "${id}": ${detail}`, { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(record: Record<string, unknown>, key: string, id: SessionIdType, minimum: number): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw corruption(id, `manifest field "${key}" is not an integer >= ${minimum}`)
  }
  return value
}

function optionalString(record: Record<string, unknown>, key: string, id: SessionIdType): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw corruption(id, `header field "${key}" is not a string`)
  return value
}

/**
 * Encode a validated header into a manifest.
 * @param manifest - the manifest to serialize.
 * @returns the compact JSON document.
 */
export function encodeManifest(manifest: SessionManifest): string {
  return JSON.stringify(manifest)
}

/**
 * Encode one contiguous event batch as JSONL.
 * @param events - the non-empty batch in sequence order.
 * @returns the body and its digest metadata.
 */
export function encodeFragment(events: readonly SessionEvent[]): EncodedFragment {
  if (events.length === 0) throw new Error('cannot encode an empty session fragment')
  const body = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
  return {
    body,
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: Buffer.byteLength(body, 'utf8'),
  }
}

/**
 * Parse and validate one stored manifest document.
 * @param raw - the object body.
 * @param id - the requested session identity.
 * @returns the validated manifest.
 * @throws {SessionPersistenceCorruptionError} for a malformed document.
 */
export function parseManifest(raw: string, id: SessionIdType): SessionManifest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw corruption(id, 'manifest is not valid JSON', error)
  }
  if (!isRecord(value)) throw corruption(id, 'manifest is not a JSON object')
  if (value['format'] !== MANIFEST_FORMAT) {
    throw corruption(id, `manifest format ${String(value['format'])} is unsupported`)
  }
  if (value['id'] !== id) {
    throw corruption(id, `manifest identity is ${JSON.stringify(value['id'])}`)
  }
  const header = parseHeader(value['header'], id)
  const inheritedEventCount = integer(value, 'inheritedEventCount', id, 0)
  if (header.isSeeded ? inheritedEventCount <= 0 : inheritedEventCount !== 0) {
    throw corruption(id, 'manifest inherited event count does not match the header lineage')
  }
  const revision = integer(value, 'revision', id, 1)
  const updatedAt = integer(value, 'updatedAt', id, 0)
  const entries = value['fragments']
  if (!Array.isArray(entries)) throw corruption(id, 'manifest fragments is not an array')
  const fragments: FragmentRef[] = []
  let cursor = 0
  for (const entry of entries) {
    const fragment = parseFragmentRef(entry, id, cursor)
    fragments.push(fragment)
    cursor += fragment.count
  }
  if (inheritedEventCount > cursor) {
    throw corruption(id, 'inherited event count exceeds the stored log length')
  }
  return {
    format: MANIFEST_FORMAT,
    id,
    header,
    inheritedEventCount,
    revision,
    fragments,
    updatedAt,
  }
}

function parseHeader(value: unknown, id: SessionIdType): SessionHeader {
  if (!isRecord(value)) throw corruption(id, 'manifest header is not an object')
  if (value['id'] !== id) throw corruption(id, 'header identity does not match the requested session')
  const version = value['version']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw corruption(id, 'header version is not a non-negative integer')
  }
  const createdAt = value['createdAt']
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw corruption(id, 'header createdAt is not a non-negative integer')
  }
  const isSeeded = value['isSeeded']
  if (typeof isSeeded !== 'boolean') throw corruption(id, 'header isSeeded is not a boolean')
  const cwd = optionalString(value, 'cwd', id)
  const parentSession = optionalString(value, 'parentSession', id)
  const agentPreset = optionalString(value, 'agentPreset', id)
  const origin = value['origin']
  if (origin !== undefined && (typeof origin !== 'string' || !ORIGINS.has(origin))) {
    throw corruption(id, 'header origin is not a supported value')
  }
  const delegationDepth = value['delegationDepth'] === undefined
    ? 0
    : integer(value, 'delegationDepth', id, 0)
  return {
    version: version as typeof SESSION_FORMAT_VERSION,
    id,
    createdAt,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(parentSession !== undefined ? { parentSession: SessionId(parentSession) } : {}),
    isSeeded,
    ...(origin !== undefined ? { origin: origin as 'subagent' } : {}),
    delegationDepth,
    ...(agentPreset !== undefined ? { agentPreset } : {}),
  }
}

function parseFragmentRef(value: unknown, id: SessionIdType, expectedFirstSeq: number): FragmentRef {
  if (!isRecord(value)) throw corruption(id, 'manifest fragment entry is not an object')
  const name = value['name']
  if (typeof name !== 'string' || !FRAGMENT_NAME.test(name)) {
    throw corruption(id, 'manifest fragment name is invalid')
  }
  const firstSeq = integer(value, 'firstSeq', id, 0)
  if (firstSeq !== expectedFirstSeq) {
    throw corruption(id, 'manifest fragments are not contiguous')
  }
  const count = integer(value, 'count', id, 1)
  const sha256 = value['sha256']
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw corruption(id, `fragment "${name}" carries an invalid digest`)
  }
  const bytes = integer(value, 'bytes', id, 1)
  return { name, firstSeq, count, sha256, bytes }
}

/**
 * Decode one immutable fragment and verify its manifest digest.
 * @param body - the stored object body.
 * @param ref - the manifest entry that names it.
 * @param id - the stored session identity.
 * @returns the parsed, unvalidated events in sequence order.
 * @throws {SessionPersistenceCorruptionError} when the object does not match its manifest entry.
 */
export function decodeFragment(body: string, ref: FragmentRef, id: SessionIdType): SessionEvent[] {
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes !== ref.bytes) {
    throw corruption(id, `fragment "${ref.name}" is ${bytes} bytes, manifest says ${ref.bytes}`)
  }
  if (createHash('sha256').update(body).digest('hex') !== ref.sha256) {
    throw corruption(id, `fragment "${ref.name}" does not match its manifest digest`)
  }
  const lines = body.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== ref.count) {
    throw corruption(id, `fragment "${ref.name}" holds ${lines.length} events, manifest says ${ref.count}`)
  }
  const events: SessionEvent[] = []
  for (const line of lines) {
    if (line === '') throw corruption(id, `fragment "${ref.name}" contains an empty record`)
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw corruption(id, `fragment "${ref.name}" contains an invalid record`, error)
    }
    if (!isRecord(parsed)) throw corruption(id, `fragment "${ref.name}" contains a non-object record`)
    events.push(parsed as unknown as SessionEvent)
  }
  if (events[0]?.seq !== ref.firstSeq) {
    throw corruption(id, `fragment "${ref.name}" does not start at sequence ${ref.firstSeq}`)
  }
  return events
}
