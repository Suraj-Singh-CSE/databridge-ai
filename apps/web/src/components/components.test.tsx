import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProgressBar } from '@/components/ProgressBar';
import { StatusPill } from '@/components/StatusPill';
import { Stepper } from '@/components/Stepper';

describe('Stepper', () => {
  it('marks earlier steps done, the current step current and later steps todo', () => {
    render(<Stepper current="mapping" />);

    const steps = within(screen.getByRole('list', { name: 'Project steps' })).getAllByRole(
      'listitem',
    );
    expect(steps.map((step) => step.dataset.state)).toEqual([
      'done',
      'done',
      'current',
      'todo',
      'todo',
      'todo',
    ]);
    expect(steps[2]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).toHaveTextContent('Sources, done');
    expect(steps[2]).toHaveTextContent('3Mapping, current step');
    expect(steps[5]).toHaveTextContent('6Quality, not started');
  });

  it('has no done steps at the first step', () => {
    render(<Stepper current="sources" />);

    const steps = screen.getAllByRole('listitem');
    expect(steps.filter((step) => step.dataset.state === 'done')).toHaveLength(0);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
  });
});

describe('StatusPill', () => {
  it('always carries a text label', () => {
    render(<StatusPill tone="review">Review · 0.78</StatusPill>);

    expect(screen.getByText('Review · 0.78')).toBeInTheDocument();
  });
});

describe('ProgressBar', () => {
  it('reports its value to assistive technology, clamped to 0-100', () => {
    render(<ProgressBar value={1.4} label="Upload" />);

    expect(screen.getByRole('progressbar', { name: 'Upload' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });
});
