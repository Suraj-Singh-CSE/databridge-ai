import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, fieldErrorsOf } from '@/lib/api';

import { useCreateProject } from './queries';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a project name.').max(80, 'Use 80 characters or fewer.'),
  description: z.string().trim().max(500, 'Use 500 characters or fewer.'),
});
type FormValues = z.infer<typeof schema>;

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'You do not have permission to create projects.';
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps) {
  const navigate = useNavigate();
  const createProject = useCreateProject();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '' },
  });
  const { errors, isSubmitting } = form.formState;

  function handleOpenChange(next: boolean) {
    if (!next) {
      form.reset();
      setServerError(null);
    }
    onOpenChange(next);
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const project = await createProject.mutateAsync(values);
      toast.success(`Project "${project.name}" created`);
      handleOpenChange(false);
      await navigate(`/projects/${encodeURIComponent(project.id)}/sources`);
    } catch (error) {
      const fields = error instanceof ApiError ? fieldErrorsOf(error) : {};
      if (fields.name) form.setError('name', { message: `Name ${fields.name}.` });
      if (fields.description) {
        form.setError('description', { message: `Description ${fields.description}.` });
      }
      if (!fields.name && !fields.description) setServerError(messageFor(error));
    }
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="grid gap-5">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project turns a set of source files into one clean dataset.
            </DialogDescription>
          </DialogHeader>

          {serverError && (
            <Alert>
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              autoComplete="off"
              placeholder="Customer 360 demo"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'project-name-error' : undefined}
              {...form.register('name')}
            />
            {errors.name && (
              <p id="project-name-error" className="text-sm text-destructive">
                {errors.name.message}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="project-description">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="project-description"
              rows={3}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={errors.description ? 'project-description-error' : undefined}
              {...form.register('description')}
            />
            {errors.description && (
              <p id="project-description-error" className="text-sm text-destructive">
                {errors.description.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
