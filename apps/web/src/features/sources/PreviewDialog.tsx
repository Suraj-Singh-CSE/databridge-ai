import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { Source } from '@/lib/api-types';

import { useSourcePreview } from './queries';

interface PreviewDialogProps {
  projectId: string;
  /** The source to preview; null closes the dialog. */
  source: Source | null;
  onClose: () => void;
}

/** The first rows of a file exactly as uploaded (project members only; never sent to the AI). */
export function PreviewDialog({ projectId, source, onClose }: PreviewDialogProps) {
  const preview = useSourcePreview(projectId, source?.id ?? null);

  let body;
  if (preview.isPending) {
    body = (
      <div role="status" aria-label="Loading preview" className="space-y-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  } else if (preview.isError) {
    body = (
      <Alert>
        <AlertDescription>We could not load the preview. {preview.error.message}</AlertDescription>
      </Alert>
    );
  } else if (preview.data.rows.length === 0) {
    body = <p className="text-sm text-muted-foreground">This file has a header but no rows.</p>;
  } else {
    const { columns, rows } = preview.data;
    body = (
      <div
        className="max-h-[60vh] overflow-auto rounded-lg border"
        tabIndex={0}
        role="region"
        aria-label="Preview rows"
      >
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
            <tr>
              {columns.map((column, index) => (
                <th key={index} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                  {column || `Column ${index + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="max-w-60 truncate px-3 py-2 whitespace-nowrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Preview · {source?.originalFilename}</DialogTitle>
          <DialogDescription>
            The first rows as they are in the file. Only project members can see this preview.
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
