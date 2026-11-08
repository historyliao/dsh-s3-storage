import { createHash } from 'node:crypto'
import { adoptSessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from '@deepseek-ai/dsh-session-persistence'
import { freezeSessionEvent } from './freeze.js'
import { encodeFragment, encodeManifest } from './manifest.js'
import { MANIFEST_FORMAT } from './manifest.js'
import type { FragmentRef, SessionManifest } from './manifest.js'
import { fragmentKey, fragmentName, manifestKey } from './keys.js'
import type { S3Store } from './s3.js'
import type { SessionLease } from './lease.js'
import type { SessionState } from './state.js'

/** What one handle needs from its owning backend. */
export interface SessionHandleHost {
  /** Bucket access shared by every handle of this backend. */
  readonly store: S3Store
  /** Normalized object key prefix. */
  readonly prefix: string
  /**
   * Build an unacquired write lease for one session.
   * @param id - the stored session identity.
   * @returns the lease the handle acquires before its first durable write.
   */
  newLease(id: SessionId): SessionLease
  /**
   * Remove a closed handle from the backend's route and ownership tables.
   * @param handle - the handle that finished closing.
   */
  release(handle: S3SessionHandle): void
}

/**
 * One open channel onto an S3-stored session. Every handle of the same session
 * shares the backend's {@link SessionState}, so a read handle observes appends
 * resolved on the write handle before they are flushed. Appends stay in memory
 * until `flush`/`close`, where one immutable fragment object is followed by a
 * conditionally-written manifest that commits it.
 */
export class S3SessionHandle implements SessionHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly access: SessionAccess

  private readonly live: SessionEvent[] = []
  private chain: Promise<void> = Promise.resolve()
  private draining: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private stopping = false
  private closed = false

  /**
   * @param host - the owning backend.
   * @param state - shared process-local session state.
   * @param access - read or single-writer write.
   */
  constructor(
    private readonly host: SessionHandleHost,
    private readonly state: SessionState,
    access: SessionAccess,
  ) {
    this.id = state.id
    this.access = access
    this.header = state.header
    this.inheritedEventCount = state.inheritedEventCount
  }

  /**
   * Append a contiguous batch; see the seam contract.
   * @param events - the contiguous batch in sequence order.
   * @param options - optional cancellation.
   */
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    options?.signal?.throwIfAborted()
    const batch = materializeAppendBatch(events)
    await this.enqueueAppend(batch, options?.signal)
  }

  /**
   * Read one slice of the process-local log.
   * @param offset - first event sequence to include.
   * @param length - maximum number of events to return.
   * @param options - optional cancellation.
   * @returns the requested slice and its value ownership state.
   */
  async read(
    offset = 0,
    length = Number.MAX_SAFE_INTEGER,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`)
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`)
    }
    options?.signal?.throwIfAborted()
    await this.chain
    return { eventState: 'shared-frozen', events: this.state.events.slice(offset, offset + length) }
  }

  /**
   * Durability barrier: commit every acknowledged append.
   * @param options - optional cancellation observed before the barrier starts.
   */
  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
    options?.signal?.throwIfAborted()
    await this.drainLive()
    await this.run(() => this.commit(options?.signal))
  }

  /**
   * Release the handle: drain routed events, commit pending appends, and drop
   * write ownership. A created session that never received an event leaves no
   * durable artifact. Idempotent.
   * @returns settlement of the release.
   */
  close(): Promise<void> {
    this.stopping = true
    return this.closing ??= this.runClose()
  }

  /** `await using` support: delegates to {@link close}. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /**
   * Buffer one published live event and start draining it into the log.
   * @param event - the live event to retain.
   * @param report - observes a background drain failure.
   */
  enqueueLive(event: SessionEvent, report: (error: unknown) => void): void {
    if (this.closed) return
    try {
      this.live.push(structuredClone(event))
    } catch (error) {
      report(error)
      return
    }
    void this.drainLive().catch(report)
  }

  /**
   * Drain the routed live buffer in order; a failed batch stays at the front.
   * @returns resolution once the buffer is empty.
   */
  drainLive(): Promise<void> {
    return this.draining ??= this.drainLoop().finally(() => {
      this.draining = undefined
    })
  }

  private async drainLoop(): Promise<void> {
    while (this.live.length > 0) {
      const batch = this.live.splice(0)
      try {
        await this.enqueueAppend(batch)
      } catch (error) {
        this.live.unshift(...batch)
        throw error
      }
    }
  }

  private async runClose(): Promise<void> {
    const failures: unknown[] = []
    try {
      for (;;) {
        await this.drainLive()
        await this.chain
        if (this.live.length !== 0) continue
        if (this.access === 'write' && (this.state.materialized || this.state.events.length > 0)) {
          await this.run(() => this.commit())
        }
        if (this.live.length === 0) break
      }
    } catch (error) {
      failures.push(error)
    }
    try {
      await this.state.lease?.release()
    } catch (error) {
      failures.push(error)
    }
    this.closed = true
    this.host.release(this)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `session "${this.id}": close failed`)
  }

  private enqueueAppend(batch: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      signal?.throwIfAborted()
      this.assertWritable('append')
      assertContiguous(this.id, batch, this.state.events.length)
      for (const event of batch) {
        const adopted = freezeSessionEvent(adoptSessionEvent(event))
        this.state.events.push(adopted)
        this.state.pending.push(adopted)
      }
      this.state.revision += batch.length
    })
  }

  private async commit(signal?: AbortSignal): Promise<void> {
    const state = this.state
    if (state.materialized && state.pending.length === 0) return
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
    let lease = state.lease
    if (lease === undefined) {
      lease = this.host.newLease(this.id)
      await lease.acquire(signal)
      state.lease = lease
    }
    lease.assertOwned()
    const batch = state.pending
    let fragment: FragmentRef | undefined
    if (batch.length > 0) {
      const firstSeq = state.events.length - batch.length
      const { body, sha256, bytes } = encodeFragment(batch)
      const name = fragmentName(firstSeq, sha256)
      const key = fragmentKey(this.host.prefix, this.id, name)
      const stored = await this.host.store.put(key, body, { ifNoneMatch: '*' }, signal)
      if (stored === 'precondition') {
        const existing = await this.host.store.get(key, signal)
        if (existing === undefined || createHash('sha256').update(existing.body).digest('hex') !== sha256) {
          throw new SessionPersistenceCorruptionError(
            `session "${this.id}": fragment "${name}" already exists with different content`,
            { cause: undefined },
          )
        }
      }
      fragment = { name, firstSeq, count: batch.length, sha256, bytes }
    }
    const fragments = fragment === undefined
      ? (state.manifest?.fragments ?? [])
      : [...(state.manifest?.fragments ?? []), fragment]
    const revision = (state.manifest?.revision ?? 0) + 1
    const manifest: SessionManifest = {
      format: MANIFEST_FORMAT,
      id: this.id,
      header: this.header,
      inheritedEventCount: state.inheritedEventCount,
      revision,
      fragments,
      updatedAt: Date.now(),
    }
    const body = encodeManifest(manifest)
    const key = manifestKey(this.host.prefix, this.id)
    if (!state.materialized) {
      const written = await this.host.store.put(key, body, { ifNoneMatch: '*' }, signal)
      if (written === 'precondition') {
        const current = await this.host.store.get(key, signal)
        if (current === undefined || current.body !== body) throw new SessionAlreadyExistsError(this.id)
        state.etag = current.etag
      } else {
        state.etag = written.etag
      }
      state.materialized = true
    } else {
      if (state.etag === undefined) {
        throw new SessionPersistenceCorruptionError(
          `session "${this.id}": materialized state carries no manifest ETag`,
          { cause: undefined },
        )
      }
      const written = await this.host.store.put(key, body, { ifMatch: state.etag }, signal)
      if (written === 'precondition') {
        const current = await this.host.store.get(key, signal)
        if (current !== undefined && current.body === body) {
          state.etag = current.etag
        } else {
          lease.markLost()
          throw new SessionOwnershipLostError(this.id)
        }
      } else {
        state.etag = written.etag
      }
    }
    state.manifest = manifest
    state.revision = Math.max(state.revision, revision)
    state.pending = []
  }

  private run(job: () => Promise<void>): Promise<void> {
    const result = this.chain.then(job, job)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private assertOpen(operation: string): void {
    if (this.closed || this.stopping) throw new SessionHandleClosedError(this.id, operation)
  }

  private assertWritable(operation: string): void {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, operation)
    this.state.lease?.assertOwned()
  }
}
