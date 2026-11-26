/**
 * What an error may put in a log line (finding G3-19, ADR 0028). MongoDB duplicate-key errors
 * carry the clashing value (often an email) in `message`, `errmsg`, `keyValue` and the first line
 * of `stack`; validation errors can echo request bodies. The serializer keeps only the error's
 * name, codes and a scrubbed message/stack, and never copies any other property.
 */

const EMAIL = /[^\s@"'{}:,]+@[^\s@"'{}:,]+/g;
const LONG_DIGITS = /\d{6,}/g;
// `... dup key: { email: "a@b.c" }` -> `... dup key: [REDACTED]`
const DUP_KEY = /dup key:\s*\{[^}]*\}?/g;
const MAX_MESSAGE_CHARS = 300;

export interface SafeError {
  type: string;
  message: string;
  code?: string | number;
  codeName?: string;
  stack?: string;
}

/** Removes duplicate-key values, emails and digit runs (phones, ids) from a message. */
export function scrubMessage(text: string): string {
  const scrubbed = text
    .replace(DUP_KEY, 'dup key: [REDACTED]')
    .replace(EMAIL, '[EMAIL]')
    .replace(LONG_DIGITS, '[NUM]');
  return scrubbed.length > MAX_MESSAGE_CHARS
    ? `${scrubbed.slice(0, MAX_MESSAGE_CHARS - 1)}…`
    : scrubbed;
}

function scalar(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * pino `err` serializer: name, code, codeName, scrubbed message and stack frames only. It also
 * accepts the plain object pino-http's wrapper passes (already through pino's std serializer,
 * which copies every own property such as `keyValue`): only the same few fields are read.
 */
export function serializeError(err: unknown): SafeError {
  if (typeof err !== 'object' || err === null) {
    return { type: typeof err, message: typeof err === 'string' ? scrubMessage(err) : '' };
  }
  const fields = err as Record<string, unknown>;
  const name = scalar(fields.name) ?? scalar(fields.type);
  const type = typeof name === 'string' && name ? name : err instanceof Error ? 'Error' : 'object';
  const rawMessage = scalar(fields.message);
  const message = typeof rawMessage === 'string' ? scrubMessage(rawMessage) : '';
  const safe: SafeError = { type, message };
  const code = scalar(fields.code);
  if (code !== undefined) safe.code = code;
  const codeName = scalar(fields.codeName);
  if (typeof codeName === 'string') safe.codeName = codeName;
  const stack = scalar(fields.stack);
  if (typeof stack === 'string') {
    // The first stack line repeats the raw message; keep the frames only.
    const frames = stack.split('\n').filter((line) => line.trimStart().startsWith('at '));
    safe.stack = [`${type}: ${message}`, ...frames].join('\n');
  }
  return safe;
}
