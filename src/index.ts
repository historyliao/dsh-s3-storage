import type { Context } from '@deepseek-ai/cordis'
import { S3SessionPersistence } from './backend.js'
import type { Config } from './config.js'

export { Config } from './config.js'
export { S3SessionPersistence } from './backend.js'

/** Cordis plugin name. */
export const name = 'session-persistence-s3'

/**
 * Mount the S3 session backend as `ctx.sessionPersistence`.
 * @param ctx - owning plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  new S3SessionPersistence(ctx, config).install(ctx)
}
