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

const booleanFlag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

/** Comma-separated list; blanks are dropped (e.g. `REGISTRATION_INVITE_CODES=a, b,`). */
const commaList = () =>
  z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );

export const REGISTRATION_MODES = ['open', 'invite', 'closed'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

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
    // Before an enqueue or a question, wake a sleeping ai-service (free hosting) by polling its
    // /health with backoff for up to this long; 0 = never wait (ADR 0026).
    AI_SERVICE_WAKE_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(90_000),
    // Project assistant (ADR 0025): one answer may wait for the model, so a longer timeout.
    ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
    // Questions per user per window (in memory, per api process; Redis at Gate 3).
    ASSISTANT_RATE_LIMIT_MAX: positiveInt(20),
    ASSISTANT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    // Turns kept per conversation (the oldest are dropped).
    ASSISTANT_MAX_TURNS: positiveInt(50),
    CORS_ORIGIN: z.url({ error: 'is required and must be a valid URL' }),
    TRUST_PROXY: trustProxy,
    // Sign-in and registration attempts per client IP + email (brute-force guard; ADR 0027).
    AUTH_RATE_LIMIT_MAX: positiveInt(10),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(15 * 60 * 1000),
    // Session calls (refresh, me, logout, config) per client IP: generous, so normal use
    // (several tabs, reloads) never locks anyone out.
    SESSION_RATE_LIMIT_MAX: positiveInt(120),
    SESSION_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(15 * 60 * 1000),

    // Access control (ADR 0027). Only a user with exactly this email becomes admin; unset = nobody.
    BOOTSTRAP_ADMIN_EMAIL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .trim()
        .toLowerCase()
        .pipe(z.email({ error: 'must be a valid email' }))
        .optional(),
    ),
    REGISTRATION_MODE: z.enum(REGISTRATION_MODES).default('open'),
    REGISTRATION_INVITE_CODES: commaList(),

    // Same-origin web app (ADR 0027): the api serves the built SPA (apps/web/dist).
    SERVE_WEB: booleanFlag('false'),
    WEB_DIST_DIR: z.string().trim().min(1).default('../web/dist'),

    // File uploads and storage (ADR 0009).
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().trim().min(1).default('./data/uploads'),
    S3_BUCKET: optionalString(),
    S3_REGION: optionalString(),
    S3_ENDPOINT: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.url({ error: 'must be a valid URL' }).optional(),
    ),
    S3_FORCE_PATH_STYLE: booleanFlag('false'),
    S3_ACCESS_KEY_ID: optionalString(),
    S3_SECRET_ACCESS_KEY: optionalString(),
    MAX_UPLOAD_BYTES: positiveInt(50 * MIB),
    MAX_UPLOAD_ROWS: positiveInt(200_000),
    MAX_SOURCES_PER_PROJECT: positiveInt(10),
    // Zip-bomb guard for XLSX previews; the profiler reads the same variables (ADR 0011).
    XLSX_MAX_UNCOMPRESSED_BYTES: z.coerce
      .number()
      .int()
      .min(MIB)
      .default(200 * MIB),
    XLSX_MAX_COMPRESSION_RATIO: z.coerce.number().min(10).default(100),
    UPLOAD_RATE_LIMIT_MAX: positiveInt(30),
    UPLOAD_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(60 * 60 * 1000),

    // Background jobs (ADR 0010).
    // A running job whose worker sent no heartbeat for this long is reported as WORKER_LOST.
    JOB_STALE_AFTER_SECONDS: positiveInt(300),
    // A queued job no worker claimed for this long (while no other job runs) is reported as
    // QUEUE_LOST: its queue message was lost, e.g. when a free Redis restarted (ADR 0026).
    JOB_QUEUED_STALE_AFTER_SECONDS: positiveInt(600),
    // Keep-alive comment interval on /jobs/:jobId/events; the job is also re-read each time.
    JOB_EVENTS_KEEPALIVE_MS: z.coerce.number().int().min(10).default(15_000),
  })
  .superRefine((env, ctx) => {
    if (env.REGISTRATION_MODE === 'invite') {
      if (env.REGISTRATION_INVITE_CODES.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['REGISTRATION_INVITE_CODES'],
          message: 'is required when REGISTRATION_MODE=invite',
        });
      }
      if (env.REGISTRATION_INVITE_CODES.some((code) => code.length < 8)) {
        ctx.addIssue({
          code: 'custom',
          path: ['REGISTRATION_INVITE_CODES'],
          message: 'every invite code must be at least 8 characters',
        });
      }
    }
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
    if (
      env.REGISTRATION_INVITE_CODES.some((code) => code.toLowerCase().includes(PLACEHOLDER_MARKER))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['REGISTRATION_INVITE_CODES'],
        message: `still contains the "${PLACEHOLDER_MARKER}" placeholder; set real invite codes`,
      });
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
