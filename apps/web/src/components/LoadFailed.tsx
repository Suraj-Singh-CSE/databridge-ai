import { CircleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** A section that could not load: what failed, the server's message and a retry button. */
export function LoadFailed({
  title,
  message,
  retry,
}: {
  title: string;
  message: string;
  retry: () => void;
}) {
  return (
    <Alert>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        {message}
        <Button size="sm" variant="outline" onClick={retry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
