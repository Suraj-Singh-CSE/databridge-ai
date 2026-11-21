import { z } from 'zod';

const TEST_DEFAULTS = {
  MONGODB_URI: 'mongodb://localhost:27017/databridge_test',
  REDIS_URL: 'redis://localhost:6379/1',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  AI_SERVICE_URL: 'http://localhost:8000',
  AI_SERVICE_TOKEN: 'test-service-token',
  CORS_ORIGIN: 'http://localhost:5173',
} as const;

/** Secrets that must never keep a placeholder value in production. */
const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'AI_SERVICE_TOKEN'] as const;
const PLACEHOLDER_MARKER = 'change-me';

const required = () => z.string({ error: 'is required' });

/** Optional string where an empty value (e.g. `S3_ENDPOINT=` in compose) means "not set". */
const optionalString = () =>
  z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().min(1).optional());

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

const MIB = 1024 * 1024;
const secret = required().min(32, 'must be at least 32 characters');

/**
 * Express "trust proxy" setting. "false" (default) trusts no proxy, so req.ip is the socket
 * address. "true" trusts every hop (unsafe when the api port is reachable directly), a number
 * trusts that many hops, anything else is passed through (e.g. "loopback" or a subnet list).
 */
const trustProxy = z
  .string()
  .trim()
  .default('false')
  .transform((value): boolean | number | string => {
    if (value === 'false' || value === '') return false;
    if (value === 'true') return true;
    if (/^\d+$/.test(value)) return Number(value);
    return value;
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGODB_URI: required().regex(
      /^mongodb(\+srv)?:\/\//,
      'must be a mongodb:// or mongodb+srv:// URI',
    ),
    REDIS_URL: required().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    AI_SERVICE_URL: z.url({ error: 'is required and must be a valid URL' }),
    AI_SERVICE_TOKEN: required().min(16, 'must be at least 16 characters'),
    // Timeout for one api -> ai-service call (enqueue or cancel a job).
    AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
    CORS_ORIGIN: z.url({ error: 'is required and must be a valid URL' }),
    TRUST_PROXY: trustProxy,
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(15 * 60 * 1000),

    // File uploads and storage (ADR 0009).
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().trim().min(1).default('./data/uploads'),
    S3_BUCKET: optionalString(),
    S3_REGION: optionalString(),
    S3_ENDPOINT: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.url({ error: 'must be a valid URL' }).optional(),
    ),
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    S3_ACCESS_KEY_ID: optionalString(),
    S3_SECRET_ACCESS_KEY: optionalString(),
    MAX_UPLOAD_BYTES: positiveInt(50 * MIB),
    MAX_UPLOAD_ROWS: positiveInt(200_000),
    MAX_SOURCES_PER_PROJECT: positiveInt(10),
    UPLOAD_RATE_LIMIT_MAX: positiveInt(30),
    UPLOAD_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(60 * 60 * 1000),

    // Background jobs (ADR 0010).
    // A running job whose worker sent no heartbeat for this long is reported as WORKER_LOST.
    JOB_STALE_AFTER_SECONDS: positiveInt(300),
    // Keep-alive comment interval on /jobs/:jobId/events; the job is also re-read each time.
    JOB_EVENTS_KEEPALIVE_MS: z.coerce.number().int().min(10).default(15_000),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_REGION'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when STORAGE_DRIVER=s3',
          });
        }
      }
      if (!env.S3_ACCESS_KEY_ID !== !env.S3_SECRET_ACCESS_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_SECRET_ACCESS_KEY'],
          message: 'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither',
        });
      }
    }
    if (env.NODE_ENV !== 'production') return;
    for (const key of SECRET_KEYS) {
      if (env[key].toLowerCase().includes(PLACEHOLDER_MARKER)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `still contains the "${PLACEHOLDER_MARKER}" placeholder; set a real secret`,
        });
      }
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'must be different from JWT_ACCESS_SECRET',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validates environment variables once at startup. Throws a ConfigError naming every
 * invalid or missing variable (never their values) so the process fails fast.
 * When NODE_ENV=test, safe non-secret defaults fill anything not set.
 * When NODE_ENV=production, placeholder secrets and a shared JWT secret are rejected.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const source = env.NODE_ENV === 'test' ? { ...TEST_DEFAULTS, ...env } : env;
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(
      `Invalid environment configuration:\n${problems}\nSee .env.example for every required variable.`,
    );
  }
  return result.data;
}
