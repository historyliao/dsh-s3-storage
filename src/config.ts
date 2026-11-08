import z from '@deepseek-ai/schemastery'

/** Plugin configuration for the S3 session backend. */
export interface Config {
  /** Bucket holding every session object. */
  bucket: string
  /** Key prefix for all objects; a non-empty value is normalized to end with `/`. */
  prefix?: string
  /** Signing region; must match the endpoint's region for S3-compatible stores. */
  region?: string
  /** Custom S3-compatible endpoint (MinIO, R2). Omit for AWS S3. */
  endpoint?: string
  /** Use path-style addressing; defaults to true when `endpoint` is set. */
  forcePathStyle?: boolean
  /** Explicit access key; requires `secretAccessKey` and bypasses the default credential chain. */
  accessKeyId?: string
  /** Explicit secret key; requires `accessKeyId`. */
  secretAccessKey?: string
  /** Session token for temporary credentials. */
  sessionToken?: string
}

/** Loader schema for {@link Config}. */
export const Config: z<Config> = z.object({
  bucket: z.string().required(),
  prefix: z.string(),
  region: z.string(),
  endpoint: z.string(),
  forcePathStyle: z.boolean(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  sessionToken: z.string(),
})
