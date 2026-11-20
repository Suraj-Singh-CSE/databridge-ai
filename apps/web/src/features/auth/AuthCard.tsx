import type { ReactNode } from 'react';

import { BrandMark } from '@/components/BrandMark';

interface AuthCardProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

/** Centered 400px white card on a light grey page, with the demo-data note underneath. */
export function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-muted px-4 py-10">
      <div className="w-full max-w-[400px] rounded-xl border bg-card p-5 text-card-foreground shadow-xs">
        <BrandMark />
        <h1 className="mt-6 text-xl font-medium tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        <div className="mt-5">{children}</div>
        <p className="mt-5 text-sm text-muted-foreground">{footer}</p>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Demo data only. Never upload real customer data.
      </p>
    </main>
  );
}
