import { cn } from '@/lib/utils';

/** The 24px dark rounded square logo followed by the product name. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5 text-[15px] font-semibold', className)}>
      <span aria-hidden="true" className="size-6 rounded-md bg-primary" />
      DataBridge AI
    </span>
  );
}
