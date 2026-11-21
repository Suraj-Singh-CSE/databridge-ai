import { CircleAlert, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import type { Source } from '@/lib/api-types';

import { useDeleteSource } from './queries';

interface DeleteSourceDialogProps {
  projectId: string;
  /** The source to remove; null closes the dialog. */
  source: Source | null;
  onClose: () => void;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'You do not have permission to remove files from this project.';
  }
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

export function DeleteSourceDialog({ projectId, source, onClose }: DeleteSourceDialogProps) {
  const remove = useDeleteSource(projectId);

  const close = () => {
    remove.reset();
    onClose();
  };

  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this file?</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{source?.originalFilename}</span> and its
            profile will be deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {remove.isError && (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{messageFor(remove.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Keep file
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (!source) return;
              remove.mutate(source.id, {
                onSuccess: () => {
                  toast.success(`Removed ${source.originalFilename}`);
                  close();
                },
              });
            }}
          >
            {remove.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            Remove file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
