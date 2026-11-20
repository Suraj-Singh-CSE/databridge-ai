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

const required = () => z.string({ error: 'is required' });
const secret = required().min(32, 'must be at least 32 characters');

const envSchema = z.object({
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
  CORS_ORIGIN: z.url({ error: 'is required and must be a valid URL' }),
});

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validates environment variables once at startup. Throws a ConfigError naming every
 * invalid or missing variable (never their values) so the process fails fast.
 * When NODE_ENV=test, safe non-secret defaults fill anything not set.
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
