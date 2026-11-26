import type { CounterBackend } from '../../rate-limit-store.js';

/**
 * Per-user question limit for the assistant: at most `max` questions in any `windowMs`
 * (sliding window). The counters are shared by every api process through Redis, and kept per
 * process while Redis is down (ADR 0028).
 */
export interface QuestionLimiter {
  /** Records one question; false when the user is over the limit (nothing is recorded). */
  take(userId: string): Promise<boolean>;
}

export function createQuestionLimiter(
  counters: CounterBackend,
  max: number,
  windowMs: number,
): QuestionLimiter {
  return {
    take: (userId) => counters.take(`assistant:${userId}`, max, windowMs),
  };
}
