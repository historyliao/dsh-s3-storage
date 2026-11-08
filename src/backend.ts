import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  assertStoredId,
  assertVersion,
  materializeCreateHeader,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionPersistenceCreateOptions,
  SessionPersistenceListOptions,
  SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import type { Config } from './config.js'
import { S3Store } from './s3.js'
import { SessionLease } from './lease.js'
import { S3SessionHandle } from './handle.js'
import type { SessionHandleHost } from './handle.js'
import { freezeSessionEvent } from './freeze.js'
import type { SessionState } from './state.js'
import {
  assertSessionKey,
  fragmentKey,
  idFromSessionPrefix,
  leaseKey,
  manifestKey,
  normalizePrefix,
  sessionsRoot,
} from './keys.js'
import { decodeFragment, parseManifest } from './manifest.js'
import type { SessionManifest } from './manifest.js'

const LIST_CONCURRENCY = 4
const FRAGMENT_CONCURRENCY = 4

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Durable session persistence over S3-compatible object storage: an immutable
 * JSONL fragment per flush plus one conditionally-written manifest as the commit
 * point, with a conditional object lease for cross-process write ownership.
 * A created session stays process-local until its first append is flushed.
 */
export class S3SessionPersistence extends SessionPersistence implements SessionHandleHost {
  override readonly name = 'session-persistence-s3'
  readonly store: S3Store
  readonly prefix: string

  private readonly states = new Map<SessionIdType, SessionState>()
  private readonly handles = new Set<S3SessionHandle>()
  private readonly writers = new Map<SessionIdType, S3SessionHandle>()
  private readonly claiming = new Set<SessionIdType>()
  private readonly openingWrites = new Set<SessionIdType>()

  /**
   * @param ctx - owning plugin context.
   * @param config - bucket, prefix, endpoint, and credential configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.store = new S3Store(config)
    this.prefix = normalizePrefix(config.prefix)
  }

  /**
   * Create a process-local session and take its write ownership. Nothing is
   * written to the bucket until the first `flush`/`close` with events; an
   * unflushed, empty session never materializes.
   * @param header - the immutable header to store.
   * @param options - optional cancellation and fork cut.
   * @returns the owned write handle.
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    if (snapshot.isSeeded && options?.inheritedEventCount === undefined) {
      throw new Error('seeded session header requires an inherited event count')
    }
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0)
    if (!snapshot.isSeeded && inheritedEventCount !== 0) {
      throw new Error('unseeded session header inherited event count must be 0')
    }
    assertSessionKey(snapshot.id)
    if (this.states.has(snapshot.id) || this.claiming.has(snapshot.id)) {
      throw new SessionAlreadyExistsError(snapshot.id)
    }
    this.claiming.add(snapshot.id)
    try {
      if (await this.store.get(manifestKey(this.prefix, snapshot.id), options?.signal) !== undefined) {
        throw new SessionAlreadyExistsError(snapshot.id)
      }
      const stored: SessionHeader = { ...snapshot, delegationDepth: snapshot.delegationDepth ?? 0 }
      const state: SessionState = {
        id: stored.id,
        header: stored,
        inheritedEventCount,
        events: [],
        pending: [],
        revision: 0,
        materialized: false,
        handles: new Set(),
      }
      this.states.set(stored.id, state)
      return this.adopt(new S3SessionHandle(this, state, 'write'), state)
    } finally {
      this.claiming.delete(snapshot.id)
    }
  }

  /**
   * Open an existing stored session, or a process-local pending one.
   * @param id - the stored session to open.
   * @param access - `read`, or `write` to claim single-writer ownership.
   * @param options - optional cancellation.
   * @returns the open handle.
   */
  async open(
    id: SessionIdType,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    assertSessionKey(id)
    if (access === 'read') {
      const existing = this.states.get(id)
      if (existing !== undefined) return this.adopt(new S3SessionHandle(this, existing, 'read'), existing)
      const loaded = await this.load(id, options?.signal)
      const current = this.states.get(id)
      const state = current ?? this.stateFromLoad(id, loaded)
      if (current === undefined) this.states.set(id, state)
      return this.adopt(new S3SessionHandle(this, state, 'read'), state)
    }
    if (this.writers.has(id) || this.openingWrites.has(id) || this.states.get(id)?.writer !== undefined) {
      throw new SessionAlreadyOwnedError(id)
    }
    this.openingWrites.add(id)
    let state = this.states.get(id)
    let created = false
    let lease: SessionLease | undefined
    try {
      // Claim ownership BEFORE reading the log so a concurrent writer cannot
      // commit between the load and this handle's first write.
      lease = this.newLease(id)
      await lease.acquire(options?.signal)
      if (state !== undefined && state.materialized) {
        const loaded = await this.load(id, options?.signal)
        state.events.length = 0
        state.events.push(...loaded.events)
        state.pending = []
        state.manifest = loaded.manifest
        state.etag = loaded.etag
        state.revision = loaded.manifest.revision
      } else if (state === undefined) {
        const loaded = await this.load(id, options?.signal)
        state = this.stateFromLoad(id, loaded)
        this.states.set(id, state)
        created = true
      }
      if (state.writer !== undefined) throw new SessionAlreadyOwnedError(id)
      state.lease = lease
      return this.adopt(new S3SessionHandle(this, state, 'write'), state)
    } catch (error) {
      await lease?.release().catch((releaseError: unknown) => {
        this.ctx.logger.warn(
          `session-persistence-s3: failed to release write lease for "${id}": ${String(releaseError)}`,
        )
      })
      if (created && state !== undefined && state.handles.size === 0 && state.writer === undefined) {
        this.states.delete(id)
      }
      throw error
    } finally {
      this.openingWrites.delete(id)
    }
  }

  /**
   * Observe one stored or process-local session without reading its log.
   * @param id - the stored session identity.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when absent.
   */
  async stat(
    id: SessionIdType,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    assertSessionKey(id)
    const state = this.states.get(id)
    if (state !== undefined) return this.snapshotOfState(state)
    return this.statCold(id, options?.signal)
  }

  /**
   * List every stored session plus process-local pending ones.
   * @param options - optional cancellation.
   * @returns one snapshot per visible session; unreadable stored sessions are skipped with a warning.
   */
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    const root = sessionsRoot(this.prefix)
    const prefixes = await this.store.listPrefixes(root, options?.signal)
    const seen = new Set<string>()
    const remote = await mapLimit(prefixes, LIST_CONCURRENCY, async prefix => {
      const raw = idFromSessionPrefix(root, prefix)
      if (raw === undefined) return undefined
      seen.add(raw)
      const state = this.states.get(SessionId(raw))
      if (state !== undefined) return this.snapshotOfState(state)
      try {
        return await this.statCold(SessionId(raw), options?.signal)
      } catch (error) {
        if (error instanceof SessionPersistenceCorruptionError || error instanceof SessionFormatUnsupportedError) {
          this.ctx.logger.warn(
            `session-persistence-s3: skipping unreadable session "${raw}" while listing: ${String(error)}`,
          )
          return undefined
        }
        throw error
      }
    })
    const snapshots = remote.filter(
      (snapshot): snapshot is SessionPersistenceSnapshot => snapshot !== undefined,
    )
    for (const [id, state] of this.states) {
      if (!seen.has(id)) snapshots.push(this.snapshotOfState(state))
    }
    return snapshots
  }

  /**
   * Flush every write handle owned by this service instance.
   * @throws {AggregateError} naming each session whose flush failed.
   */
  override async flush(): Promise<void> {
    const errors: unknown[] = []
    for (const writer of [...this.writers.values()]) {
      try {
        await writer.drainLive()
        await writer.flush()
      } catch (error) {
        if (error instanceof SessionHandleClosedError) continue
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'session-persistence-s3 flush failed')
  }

  /**
   * Install live session routing and teardown on the owning context.
   * @param ctx - the service context.
   */
  install(ctx: Context): void {
    const writers = this.writers
    const store = this.store
    const closeAll = (): Promise<void> => this.closeAll()
    ctx.effect(function* () {
      yield async () => {
        try {
          await closeAll()
        } finally {
          store.close()
        }
      }
      yield ctx.on('session/event', (session, event) => {
        writers.get(session.id)?.enqueueLive(event, (error: unknown) => {
          ctx.logger.warn(
            `session-persistence-s3: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`,
          )
        })
      })
      yield ctx.on('session/flush', async (session) => {
        const writer = writers.get(session.id)
        if (writer === undefined) return
        await writer.drainLive()
        await writer.flush()
      })
      yield ctx.on('session/disposed', (session) => {
        const writer = writers.get(session.id)
        if (writer === undefined) return
        writer.close().catch((error: unknown) => {
          ctx.logger.warn(`session-persistence-s3: final drain for session "${session.id}" failed: ${String(error)}`)
        })
      })
    }, 'session-persistence-s3 live routing and open handles')
  }

  /**
   * Close every open handle, aggregating failures.
   * @throws {AggregateError} naming each handle whose close failed.
   */
  async closeAll(): Promise<void> {
    const errors: unknown[] = []
    for (const handle of [...this.handles]) {
      try {
        await handle.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'session-persistence-s3 dispose failed')
  }

  /**
   * Remove a closed handle from the route and ownership tables.
   * @param handle - the handle that finished closing.
   */
  release(handle: S3SessionHandle): void {
    this.handles.delete(handle)
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
    const state = this.states.get(handle.id)
    if (state === undefined) return
    state.handles.delete(handle)
    if (state.writer === handle) {
      delete state.writer
      delete state.lease
      // A created session that never materialized is erased with its writer,
      // even while read handles still observe the empty in-memory log.
      if (!state.materialized) {
        this.states.delete(handle.id)
        return
      }
    }
    if (state.handles.size === 0) this.states.delete(handle.id)
  }

  /**
   * Build an unacquired write lease for one session.
   * @param id - the stored session identity.
   * @returns the lease instance; the caller acquires and releases it.
   */
  newLease(id: SessionIdType): SessionLease {
    return new SessionLease(
      this.store,
      leaseKey(this.prefix, id),
      id,
      randomUUID(),
      message => { this.ctx.logger.warn(message) },
      error => {
        this.ctx.logger.warn(`session-persistence-s3: write ownership lost for "${id}": ${String(error)}`)
      },
    )
  }

  private adopt(handle: S3SessionHandle, state: SessionState): S3SessionHandle {
    this.handles.add(handle)
    state.handles.add(handle)
    if (handle.access === 'write') {
      state.writer = handle
      this.writers.set(handle.id, handle)
    }
    return handle
  }

  private async statCold(
    id: SessionIdType,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    const stored = await this.store.get(manifestKey(this.prefix, id), signal)
    if (stored === undefined) return undefined
    return this.snapshotOfManifest(this.requireManifest(id, stored.body))
  }

  private snapshotOfState(state: SessionState): SessionPersistenceSnapshot {
    return {
      header: state.header,
      formatStatus: 'current',
      revision: SessionPersistenceRevision(String(state.revision)),
      eventCount: state.events.length,
    }
  }

  private snapshotOfManifest(manifest: SessionManifest): SessionPersistenceSnapshot {
    return {
      header: manifest.header,
      formatStatus: 'current',
      revision: SessionPersistenceRevision(String(manifest.revision)),
      eventCount: manifest.fragments.reduce((total, fragment) => total + fragment.count, 0),
    }
  }

  private stateFromLoad(
    id: SessionIdType,
    loaded: { manifest: SessionManifest; etag: string; events: readonly SessionEvent[] },
  ): SessionState {
    return {
      id,
      header: loaded.manifest.header,
      inheritedEventCount: SessionLogOffset(loaded.manifest.inheritedEventCount),
      events: [...loaded.events],
      pending: [],
      revision: loaded.manifest.revision,
      materialized: true,
      manifest: loaded.manifest,
      etag: loaded.etag,
      handles: new Set(),
    }
  }

  private async load(
    id: SessionIdType,
    signal?: AbortSignal,
  ): Promise<{ manifest: SessionManifest; etag: string; events: readonly SessionEvent[] }> {
    const stored = await this.store.get(manifestKey(this.prefix, id), signal)
    if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
    const manifest = this.requireManifest(id, stored.body)
    const batches = await mapLimit(manifest.fragments, FRAGMENT_CONCURRENCY, async fragment => {
      signal?.throwIfAborted()
      const object = await this.store.get(fragmentKey(this.prefix, id, fragment.name), signal)
      if (object === undefined) {
        throw new SessionPersistenceCorruptionError(
          `session "${id}": committed fragment "${fragment.name}" is missing`,
          { cause: undefined },
        )
      }
      const batch = decodeFragment(object.body, fragment, id)
      if (batch.length !== fragment.count || batch[0]?.seq !== fragment.firstSeq) {
        throw new SessionPersistenceCorruptionError(
          `session "${id}": fragment "${fragment.name}" does not match its manifest entry`,
          { cause: undefined },
        )
      }
      return batch
    })
    const events = batches.flat()
    for (const [index, event] of events.entries()) {
      if (event.seq !== index) {
        throw new SessionPersistenceCorruptionError(
          `session "${id}": event at position ${index} carries sequence ${event.seq}`,
          { cause: undefined },
        )
      }
    }
    if (manifest.inheritedEventCount > events.length) {
      throw new SessionPersistenceCorruptionError(
        `session "${id}": inherited event count ${manifest.inheritedEventCount} exceeds the stored log length ${events.length}`,
        { cause: undefined },
      )
    }
    validateStoredEvents(manifest.header, events)
    for (const event of events) freezeSessionEvent(event)
    return { manifest, etag: stored.etag, events }
  }

  private requireManifest(id: SessionIdType, raw: string): SessionManifest {
    const manifest = parseManifest(raw, id)
    assertStoredId(id, manifest.header)
    assertVersion(manifest.header)
    return manifest
  }
}
