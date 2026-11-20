import { Link } from 'react-router';

import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { useDocumentTitle } from '@/hooks/use-document-title';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted px-4 text-center">
      <BrandMark />
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        The page you are looking for does not exist or has moved.
      </p>
      <Button asChild>
        <Link to="/projects">Go to projects</Link>
      </Button>
    </main>
  );
}
