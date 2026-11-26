import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useDocumentTitle } from '@/hooks/use-document-title';

import { AuthCard } from './AuthCard';
import { useAuth } from './auth-context';
import { FormField } from './FormField';
import { authErrorMessage } from './form-errors';

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email.').pipe(z.email('Enter a valid email.')),
  password: z.string().min(1, 'Enter your password.').max(128, 'Use 128 characters or fewer.'),
});
type FormValues = z.infer<typeof schema>;

export function SignInPage() {
  useDocumentTitle('Sign in');
  const { signIn } = useAuth();
  const [params] = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const next = params.get('next');
  const createAccountHref = next
    ? `/create-account?next=${encodeURIComponent(next)}`
    : '/create-account';

  // On success the auth state changes and <GuestOnly> redirects to `next`.
  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await signIn(values);
    } catch (error) {
      setServerError(authErrorMessage(error, 'sign-in'));
    }
  });

  return (
    <AuthCard
      title="Sign in"
      subtitle="Turn messy data from many systems into one clean, trusted dataset."
      footer={
        <>
          No account yet?{' '}
          <Link to={createAccountHref} className="font-medium text-foreground hover:underline">
            Create one
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
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          autoFocus
          error={errors.email?.message}
          {...form.register('email')}
        />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...form.register('password')}
        />
        <Button type="submit" className="mt-1 w-full" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="text-xs text-muted-foreground">
          First load may take up to a minute on the free plan.
        </p>
      </form>
    </AuthCard>
  );
}
