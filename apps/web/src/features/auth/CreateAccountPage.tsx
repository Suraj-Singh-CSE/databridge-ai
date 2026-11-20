import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { ApiError, fieldErrorsOf } from '@/lib/api';

import { AuthCard } from './AuthCard';
import { useAuth } from './auth-context';
import { FormField } from './FormField';
import { authErrorMessage } from './form-errors';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(100, 'Use 100 characters or fewer.'),
  email: z.string().trim().min(1, 'Enter your email.').pipe(z.email('Enter a valid email.')),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(128, 'Use 128 characters or fewer.'),
});
type FormValues = z.infer<typeof schema>;
const FIELDS = ['name', 'email', 'password'] as const;

export function CreateAccountPage() {
  useDocumentTitle('Create account');
  const { register: registerAccount } = useAuth();
  const [params] = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const next = params.get('next');
  const signInHref = next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in';

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await registerAccount(values);
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = fieldErrorsOf(error);
        for (const field of FIELDS) {
          const message = fields[field];
          if (message) form.setError(field, { message: `This ${field} ${message}.` });
        }
      }
      setServerError(authErrorMessage(error, 'register'));
    }
  });

  return (
    <AuthCard
      title="Create account"
      subtitle="Start turning messy data from many systems into one clean, trusted dataset."
      footer={
        <>
          Already have an account?{' '}
          <Link to={signInHref} className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="grid gap-4">
        {serverError && (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}
        <FormField
          id="name"
          label="Name"
          autoComplete="name"
          autoFocus
          error={errors.name?.message}
          {...form.register('name')}
        />
        <FormField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="10 to 128 characters."
          error={errors.password?.message}
          {...form.register('password')}
        />
        <Button type="submit" className="mt-1 w-full" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}
