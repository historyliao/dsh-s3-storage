import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import type { S3Store } from './s3.js'

const LEASE_TTL_MS = 60_000
const LEASE_RENEW_MS = 20_000

interface LeaseRecord {
  readonly owner: string
  readonly expiresAt: number
}

function parseRecord(body: string): LeaseRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const owner = (value as Record<string, unknown>)['owner']
  const expiresAt = (value as Record<string, unknown>)['expiresAt']
  if (typeof owner !== 'string' || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
    return undefined
  }
  return { owner, expiresAt }
}

/**
 * One cross-process write lease for a stored session. Acquisition and renewal
 * use conditional writes on a dedicated object; losing the lease permanently
 * fails the owning handle instead of silently allowing a second writer.
 */
export class SessionLease {
  private etag: string | undefined
  private timer: NodeJS.Timeout | undefined
  private lost = false
  private released = false
  private renewing: Promise<void> | undefined

  /**
   * @param store - the bucket access used by the owning backend.
   * @param key - the lease object key.
   * @param sessionId - the session whose write ownership this lease represents.
   * @param owner - opaque identity of this handle's owner.
   * @param warn - observes an unreadable lease that is treated as expired.
   * @param onLost - observes permanent ownership loss while the handle is open.
   */
  constructor(
    private readonly store: S3Store,
    private readonly key: string,
    private readonly sessionId: SessionId,
    private readonly owner: string,
    private readonly warn: (message: string) => void,
    private readonly onLost: (error: unknown) => void,
  ) {}

  /**
   * Acquire the lease, taking over only an expired or unreadable record.
   * @param signal - optional cancellation.
   * @throws {SessionAlreadyOwnedError} when a live lease names another owner.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted()
      const existing = await this.store.get(this.key, signal)
      if (existing === undefined) {
        const created = await this.store.put(this.key, this.body(), { ifNoneMatch: '*' }, signal)
        if (created !== 'precondition') {
          this.etag = created.etag
          this.start()
          return
        }
        continue
      }
      const record = parseRecord(existing.body)
      if (record === undefined) {
        this.warn(`session "${this.sessionId}": unreadable write lease is treated as expired`)
      } else if (record.expiresAt > Date.now()) {
        throw new SessionAlreadyOwnedError(this.sessionId)
      }
      const taken = await this.store.put(this.key, this.body(), { ifMatch: existing.etag }, signal)
      if (taken !== 'precondition') {
        this.etag = taken.etag
        this.start()
        return
      }
    }
    throw new SessionAlreadyOwnedError(this.sessionId)
  }

  /**
   * Refuse a mutation once ownership is gone.
   * @throws {SessionOwnershipLostError} when this lease is no longer owned.
   */
  assertOwned(): void {
    if (this.lost) throw new SessionOwnershipLostError(this.sessionId)
  }

  /** Permanently mark ownership lost without waiting for the next renewal. */
  markLost(): void {
    this.fail(new SessionOwnershipLostError(this.sessionId))
  }

  /**
   * Release the lease by conditionally rewriting it as expired, so a stolen or
   * replaced lease is never deleted. A failed release leaves the lease to its
   * TTL and only rejects the caller.
   * @throws when the bucket refuses the conditional write.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.stop()
    await this.renewing?.catch(() => undefined)
    if (this.lost || this.etag === undefined) return
    const released = await this.store.put(this.key, JSON.stringify({ owner: this.owner, expiresAt: 0 }), {
      ifMatch: this.etag,
    })
    void released
  }

  private body(): string {
    const record: LeaseRecord = { owner: this.owner, expiresAt: Date.now() + LEASE_TTL_MS }
    return JSON.stringify(record)
  }

  private start(): void {
    this.timer = setInterval(() => {
      void this.renew()
    }, LEASE_RENEW_MS)
    this.timer.unref()
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async renew(): Promise<void> {
    if (this.released || this.lost) return
    this.renewing ??= this.renewOnce().finally(() => {
      this.renewing = undefined
    })
    await this.renewing
  }

  private async renewOnce(): Promise<void> {
    const etag = this.etag
    if (etag === undefined) return
    try {
      const renewed = await this.store.put(this.key, this.body(), { ifMatch: etag })
      if (renewed === 'precondition') {
        this.fail(new SessionOwnershipLostError(this.sessionId))
        return
      }
      this.etag = renewed.etag
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    if (this.lost || this.released) return
    this.lost = true
    this.stop()
    this.onLost(error)
  }
}
