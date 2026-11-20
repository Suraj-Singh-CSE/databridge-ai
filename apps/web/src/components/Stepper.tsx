import { Check } from 'lucide-react';

import { STEP_LABELS, stepState, type StepState } from '@/features/projects/steps';
import { PROJECT_STEPS, type ProjectStep } from '@/lib/api-types';
import { cn } from '@/lib/utils';

const STATE_TEXT: Record<StepState, string> = {
  done: 'done',
  current: 'current step',
  todo: 'not started',
};

/** The six workflow steps: done = filled circle with check, current = outlined number, todo = grey. */
export function Stepper({ current }: { current: ProjectStep }) {
  return (
    <ol aria-label="Project steps" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {PROJECT_STEPS.map((step, index) => {
        const state = stepState(step, current);
        return (
          <li
            key={step}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            className="flex items-center gap-3"
          >
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn('h-px w-10', state === 'todo' ? 'bg-border' : 'bg-foreground')}
              />
            )}
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-6 items-center justify-center rounded-full text-xs',
                  state === 'done' && 'bg-primary text-primary-foreground',
                  state === 'current' && 'border-[1.5px] border-foreground font-medium',
                  state === 'todo' && 'border text-muted-foreground',
                )}
              >
                {state === 'done' ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
              </span>
              <span
                className={cn(
                  'text-sm',
                  state === 'todo' ? 'text-muted-foreground' : 'text-foreground',
                  state === 'current' && 'font-medium',
                )}
              >
                {STEP_LABELS[step]}
                <span className="sr-only">, {STATE_TEXT[state]}</span>
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
