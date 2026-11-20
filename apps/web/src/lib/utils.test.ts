import { describe, expect, it } from 'vitest';

import { cn } from '@/lib/utils';

describe('cn', () => {
  it('drops falsy values and lets later Tailwind classes win', () => {
    expect(cn('p-2 text-sm', undefined, null, 'p-4')).toBe('text-sm p-4');
  });

  it('applies conditional classes from objects', () => {
    expect(cn('px-2', { 'font-bold': true, italic: false })).toBe('px-2 font-bold');
  });
});
