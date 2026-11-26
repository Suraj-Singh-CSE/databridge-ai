import { describe, expect, it } from 'vitest';

import { displayLabel } from '../src/modules/users/display-label.js';

describe('displayLabel', () => {
  it('uses the trimmed name when there is one', () => {
    expect(displayLabel({ name: '  Asha Rao ', email: 'asha@example.com' })).toBe('Asha Rao');
  });

  it('falls back to the email local part, never the full address', () => {
    expect(displayLabel({ name: '', email: 'asha.rao@example.com' })).toBe('asha.rao');
  });

  it('never returns an empty label', () => {
    expect(displayLabel({ name: ' ', email: '@example.com' })).toBe('a project member');
  });
});
