import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { SessionManifest } from './manifest.js'
import type { SessionLease } from './lease.js'

/**
 * Process-local state of one stored session, shared by every handle this
 * backend has open. `events` includes the pending (uncommitted) tail, and
 * `revision` changes on every append or commit so observers see mid-turn
 * progress. A created but never materialized session lives only here.
 */
export interface SessionState {
  /** Stored session identity. */
  readonly id: SessionId
  /** Immutable logical header. */
  readonly header: SessionHeader
  /** Fork-inherited prefix length stored beside the header. */
  readonly inheritedEventCount: SessionLogOffset
  /** Committed events followed by {@link pending}, in sequence order. */
  readonly events: SessionEvent[]
  /** Uncommitted tail of {@link events}. */
  pending: SessionEvent[]
  /** Monotonic observation token; changes on every append and commit. */
  revision: number
  /** Whether the session has a durable manifest. */
  materialized: boolean
  /** Last known manifest; absent until materialization. */
  manifest?: SessionManifest
  /** ETag of the last known manifest object, the conditional-write precondition. */
  etag?: string
  /** Cross-process write ownership; absent until the session is written. */
  lease?: SessionLease
  /** The single active write handle, when one is open. */
  writer?: SessionHandle
  /** Every handle currently open on this state. */
  readonly handles: Set<SessionHandle>
}
