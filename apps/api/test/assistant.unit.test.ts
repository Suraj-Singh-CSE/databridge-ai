import { describe, expect, it } from 'vitest';

import { createQuestionLimiter } from '../src/modules/assistant/rate-limit.js';
import { createMemoryCounters } from '../src/rate-limit-store.js';

describe('assistant question limiter', () => {
  it('allows max questions per user in a sliding window', async () => {
    let now = 0;
    const limiter = createQuestionLimiter(
      createMemoryCounters(() => now),
      2,
      60_000,
    );
    expect(await limiter.take('u1')).toBe(true);
    now = 30_000;
    expect(await limiter.take('u1')).toBe(true);
    expect(await limiter.take('u1')).toBe(false);
    expect(await limiter.take('u2')).toBe(true);
    now = 60_001;
    expect(await limiter.take('u1')).toBe(true);
    expect(await limiter.take('u1')).toBe(false);
  });

  it('two api processes on one counter store share the limit', async () => {
    const shared = createMemoryCounters(() => 0); // stands in for the one Redis
    const processA = createQuestionLimiter(shared, 2, 60_000);
    const processB = createQuestionLimiter(shared, 2, 60_000);
    expect(await processA.take('u1')).toBe(true);
    expect(await processB.take('u1')).toBe(true);
    expect(await processA.take('u1')).toBe(false);
    expect(await processB.take('u1')).toBe(false);
  });
});
