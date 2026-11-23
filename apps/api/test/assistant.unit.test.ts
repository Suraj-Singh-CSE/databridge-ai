import { describe, expect, it } from 'vitest';

import { createQuestionLimiter } from '../src/modules/assistant/rate-limit.js';

describe('assistant question limiter', () => {
  it('allows max questions per user in a sliding window', () => {
    let now = 0;
    const limiter = createQuestionLimiter(2, 60_000, () => now);
    expect(limiter.take('u1')).toBe(true);
    now = 30_000;
    expect(limiter.take('u1')).toBe(true);
    expect(limiter.take('u1')).toBe(false);
    expect(limiter.take('u2')).toBe(true);
    now = 60_001;
    expect(limiter.take('u1')).toBe(true);
    expect(limiter.take('u1')).toBe(false);
  });
});
