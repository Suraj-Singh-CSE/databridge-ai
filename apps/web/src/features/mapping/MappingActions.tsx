import { LoaderCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ProgressBar } from '@/components/ProgressBar';
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
import type { Job } from '@/lib/api-types';

interface ConfirmButtonProps {
  label: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending: boolean;
  disabled?: boolean;
  variant?: 'default' | 'outline';
  onConfirm: () => void;
}

/** A button that asks before acting; focus returns to it when the dialog closes. */
function ConfirmButton({
  label,
  title,
  description,
  confirmLabel,
  pending,
  disabled = false,
  variant = 'outline',
  onConfirm,
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={variant} disabled={disabled || pending}>
          {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
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
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AcceptHighButton({
  count,
  pending,
  onConfirm,
}: {
  count: number;
  pending: boolean;
  onConfirm: () => void;
}) {
  const plural = count === 1 ? 'suggestion' : 'suggestions';
  return (
    <ConfirmButton
      label="Accept all High"
      title={`Accept ${count} High-confidence ${plural}?`}
      description="Only columns that are still pending are accepted. You can change any of them afterwards."
      confirmLabel={`Accept ${count}`}
      pending={pending}
      disabled={count === 0}
      variant="default"
      onConfirm={onConfirm}
    />
  );
}

export function RunMappingButton({
  rerun,
  pending,
  onConfirm,
}: {
  rerun: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  if (!rerun) {
    return (
      <Button type="button" disabled={pending} onClick={onConfirm}>
        {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
        Run mapping
      </Button>
    );
  }
  return (
    <ConfirmButton
      label="Re-run mapping"
      title="Re-run mapping?"
      description="New suggestions replace the current ones. Decisions already made may become out of date, so check them again after the run."
      confirmLabel="Re-run mapping"
      pending={pending}
      onConfirm={onConfirm}
    />
  );
}

export function MappingProgress({
  filename,
  job,
  canCancel,
  cancelling,
  onCancel,
}: {
  filename: string;
  job: Job;
  canCancel: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  return (
    <section
      aria-label="Mapping progress"
      className="flex flex-col gap-3 rounded-xl border px-5 py-5"
    >
      <div role="status" className="space-y-2">
        <p className="text-sm font-medium">
          {job.status === 'queued'
            ? `Waiting to map ${filename}`
            : `Mapping ${filename}: ${job.progress}%`}
        </p>
        <ProgressBar value={job.progress / 100} label={`Mapping ${filename}`} />
        {job.message && <p className="text-sm text-muted-foreground">{job.message}</p>}
      </div>
      {canCancel && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={cancelling}
            onClick={onCancel}
          >
            Cancel mapping
          </Button>
        </div>
      )}
    </section>
  );
}
