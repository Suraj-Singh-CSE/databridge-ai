import { LoaderCircle } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';

import { CUSTOMER_ID_PATTERN, plural } from './matching-labels';
import { useCluster } from './queries';

/** Mirrors apps/api cluster.schemas.ts REASON_MAX_LENGTH. */
export const REASON_MAX_LENGTH = 300;

function ReasonField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Reason (optional)</Label>
      <Textarea
        id={id}
        value={value}
        maxLength={REASON_MAX_LENGTH}
        placeholder="e.g. Different birth date and phone"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

interface ConfirmActionProps {
  label: ReactNode;
  /** Accessible name of the trigger when `label` alone is ambiguous (e.g. per column). */
  ariaLabel?: string;
  /** Id of the text that says why the trigger is disabled. */
  describedBy?: string | undefined;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending: boolean;
  disabled?: boolean;
  withReason?: boolean;
  size?: 'sm' | 'default';
  variant?: 'default' | 'outline' | 'ghost';
  onConfirm: (reason: string | undefined) => void;
}

/** A button that asks before a review decision; focus returns to it when the dialog closes. */
export function ConfirmAction({
  label,
  ariaLabel,
  describedBy,
  title,
  description,
  confirmLabel,
  pending,
  disabled = false,
  withReason = false,
  size = 'sm',
  variant = 'outline',
  onConfirm,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason('');
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          size={size}
          variant={variant}
          disabled={disabled || pending}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
        >
          {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {withReason && <ReasonField value={reason} onChange={setReason} />}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            onClick={() => {
              setOpen(false);
              onConfirm(reason.trim() || undefined);
              setReason('');
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Finds the other customer by id, shows both sizes, and asks before merging. */
function MergeForm({
  projectId,
  customerId,
  size,
  onConfirm,
}: {
  projectId: string;
  customerId: string;
  size: number;
  onConfirm: (otherId: string, reason: string | undefined) => void;
}) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [otherId, setOtherId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const other = useCluster(projectId, otherId);
  const inputId = useId();

  const find = (event: FormEvent) => {
    event.preventDefault();
    const id = query.trim().toUpperCase();
    if (!CUSTOMER_ID_PATTERN.test(id)) {
      setError('Enter a customer id such as C1A2B3C4D5E6F.');
      setOtherId(null);
      return;
    }
    if (id === customerId) {
      setError('Pick a different customer: this is the one you are looking at.');
      setOtherId(null);
      return;
    }
    setError(null);
    setOtherId(id);
  };

  let found: ReactNode = null;
  if (otherId !== null) {
    if (other.isPending) found = <p className="text-sm text-muted-foreground">Looking it up…</p>;
    else if (other.isError) {
      found = (
        <p role="alert" className="text-sm text-destructive">
          {other.error instanceof ApiError && other.error.status === 404
            ? `No customer ${otherId} in the current groups.`
            : other.error.message}
        </p>
      );
    } else {
      found = (
        <p className="text-sm">
          Merge <span className="font-mono">{customerId}</span> ({plural(size, 'record', 'records')}
          ) with <span className="font-mono">{otherId}</span> (
          {plural(other.data.cluster.size, 'record', 'records')}) into one customer of{' '}
          {plural(size + other.data.cluster.size, 'record', 'records')}.
        </p>
      );
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={find} className="space-y-1.5">
        <Label htmlFor={inputId}>Other customer id</Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={query}
            placeholder="C1A2B3C4D5E6F"
            aria-invalid={error !== null}
            aria-describedby={error ? `${inputId}-error` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <Button type="submit" variant="outline">
            Find
          </Button>
        </div>
        {error && (
          <p id={`${inputId}-error`} className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
      <div aria-live="polite">{found}</div>
      <ReasonField value={reason} onChange={setReason} />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="button"
          disabled={!other.isSuccess || otherId === null}
          onClick={() => {
            if (otherId !== null) onConfirm(otherId, reason.trim() || undefined);
          }}
        >
          Merge customers
        </Button>
      </DialogFooter>
    </div>
  );
}

export function MergeDialog({
  projectId,
  customerId,
  size,
  pending,
  disabled,
  onConfirm,
}: {
  projectId: string;
  customerId: string;
  size: number;
  pending: boolean;
  disabled: boolean;
  onConfirm: (otherId: string, reason: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={disabled || pending}>
          {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Merge with…
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge with another customer</DialogTitle>
          <DialogDescription>
            Use this when two groups are the same person. The groups are rebuilt right after.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <MergeForm
            projectId={projectId}
            customerId={customerId}
            size={size}
            onConfirm={(otherId, reason) => {
              setOpen(false);
              onConfirm(otherId, reason);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
