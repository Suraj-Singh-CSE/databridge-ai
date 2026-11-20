import { LoaderCircle } from 'lucide-react';

/** Centered spinner with a screen-reader label, e.g. while the session is being restored. */
export function FullPageStatus({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-screen items-center justify-center bg-muted">
      <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
