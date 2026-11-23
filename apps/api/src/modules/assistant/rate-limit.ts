/**
 * Per-user question limit for the assistant: at most `max` questions in any `windowMs`
 * (sliding window). In memory, so it is per api process; a shared Redis limiter is a Gate 3
 * item when the api runs more than one instance.
 */
export interface QuestionLimiter {
  /** Records one question; false when the user is over the limit (nothing is recorded). */
  take(userId: string): boolean;
}

export function createQuestionLimiter(
  max: number,
  windowMs: number,
  now: () => number = Date.now,
): QuestionLimiter {
  const seen = new Map<string, number[]>();
  return {
    take(userId) {
      const at = now();
      const recent = (seen.get(userId) ?? []).filter((t) => at - t < windowMs);
      if (recent.length >= max) {
        seen.set(userId, recent);
        return false;
      }
      recent.push(at);
      seen.set(userId, recent);
      return true;
    },
  };
}
