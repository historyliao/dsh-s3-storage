import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { Config } from './config.js'

const REQUEST_TIMEOUT_MS = 30_000

/**
 * Combine the caller's cancellation with a fixed per-request deadline.
 * @param signal - optional caller cancellation.
 * @returns a signal that aborts on either condition.
 */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** One object read back from the bucket. */
export interface StoredObject {
  /** UTF-8 object body. */
  readonly body: string
  /** Object ETag, used as the conditional-write precondition. */
  readonly etag: string
}

/** Outcome of a conditional put: the new ETag, or a rejected precondition. */
export type ConditionalPut = { readonly etag: string } | 'precondition'

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
}

function isNotFound(error: unknown): boolean {
  if (httpStatus(error) === 404) return true
  return error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')
}

function isPrecondition(error: unknown): boolean {
  const status = httpStatus(error)
  return status === 412 || status === 409
    || (error instanceof Error && error.name === 'PreconditionFailed')
}

function isMissingBucket(error: unknown): boolean {
  return error instanceof Error && error.name === 'NoSuchBucket'
}

function conditionalWriteRefusal(key: string, error: unknown): Error | undefined {
  const status = httpStatus(error)
  const name = error instanceof Error ? error.name : ''
  if (status !== 501 && status !== 405 && name !== 'NotImplemented') return undefined
  return new Error(
    `S3 endpoint rejected conditional writes for "${key}"; dsh-s3-storage requires If-Match/If-None-Match support`,
    { cause: error },
  )
}

/** Thin wrapper for the conditional object operations the backend relies on. */
export class S3Store {
  private readonly client: S3Client
  private readonly bucket: string

  /**
   * @param config - validated plugin configuration.
   */
  constructor(config: Config) {
    if (config.bucket.trim() === '') throw new Error('bucket must be non-empty')
    const accessKeyId = config.accessKeyId
    const secretAccessKey = config.secretAccessKey
    if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
      throw new Error('accessKeyId and secretAccessKey must be provided together')
    }
    if (config.sessionToken !== undefined && accessKeyId === undefined) {
      throw new Error('sessionToken requires accessKeyId and secretAccessKey')
    }
    const credentials = accessKeyId !== undefined && secretAccessKey !== undefined
      ? {
          accessKeyId,
          secretAccessKey,
          ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
        }
      : undefined
    const region = config.region ?? (config.endpoint !== undefined ? 'us-east-1' : undefined)
    this.client = new S3Client({
      ...(region !== undefined ? { region } : {}),
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? config.endpoint !== undefined,
      ...(credentials !== undefined ? { credentials } : {}),
    })
    this.bucket = config.bucket
  }

  /**
   * Read one object.
   * @param key - object key.
   * @param signal - optional cancellation.
   * @returns the body and ETag, or `undefined` when absent.
   */
  async get(key: string, signal?: AbortSignal): Promise<StoredObject | undefined> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: withTimeout(signal) },
      )
      if (output.Body === undefined) throw new Error(`GetObject for "${key}" returned no body`)
      const body = await output.Body.transformToString('utf-8')
      if (output.ETag === undefined) throw new Error(`GetObject for "${key}" returned no ETag`)
      return { body, etag: output.ETag }
    } catch (error) {
      if (isMissingBucket(error)) throw this.bucketMissing(error)
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  /**
   * Write one object, optionally guarded by a precondition.
   * @param key - object key.
   * @param body - UTF-8 body.
   * @param conditions - `If-Match` and/or `If-None-Match` values.
   * @param signal - optional cancellation.
   * @returns the new ETag, or `'precondition'` when the guard rejected the write.
   */
  async put(
    key: string,
    body: string,
    conditions: { readonly ifMatch?: string; readonly ifNoneMatch?: string },
    signal?: AbortSignal,
  ): Promise<ConditionalPut> {
    try {
      const output = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ...(conditions.ifMatch !== undefined ? { IfMatch: conditions.ifMatch } : {}),
          ...(conditions.ifNoneMatch !== undefined ? { IfNoneMatch: conditions.ifNoneMatch } : {}),
        }),
        { abortSignal: withTimeout(signal) },
      )
      if (output.ETag === undefined) throw new Error(`PutObject for "${key}" returned no ETag`)
      return { etag: output.ETag }
    } catch (error) {
      if (isPrecondition(error)) return 'precondition'
      if (isMissingBucket(error)) throw this.bucketMissing(error)
      const refusal = conditionalWriteRefusal(key, error)
      if (refusal !== undefined) throw refusal
      throw error
    }
  }

  /**
   * List immediate child prefixes under one key prefix.
   * @param prefix - key prefix ending with `/`.
   * @param signal - optional cancellation.
   * @returns the discovered child prefixes.
   */
  async listPrefixes(prefix: string, signal?: AbortSignal): Promise<string[]> {
    const prefixes: string[] = []
    let token: string | undefined
    try {
      do {
        const output = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            Delimiter: '/',
            ...(token !== undefined ? { ContinuationToken: token } : {}),
          }),
          { abortSignal: withTimeout(signal) },
        )
        for (const entry of output.CommonPrefixes ?? []) {
          if (entry.Prefix !== undefined) prefixes.push(entry.Prefix)
        }
        token = output.IsTruncated === true ? output.NextContinuationToken : undefined
      } while (token !== undefined)
    } catch (error) {
      if (isMissingBucket(error)) throw this.bucketMissing(error)
      throw error
    }
    return prefixes
  }

  private bucketMissing(cause: unknown): Error {
    return new Error(`S3 bucket ${JSON.stringify(this.bucket)} does not exist; create it before enabling this backend`, { cause })
  }

  /** Release the HTTP client. */
  close(): void {
    this.client.destroy()
  }
}
