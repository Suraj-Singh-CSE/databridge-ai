import type { ReactNode } from 'react';

import { StatusPill } from '@/components/StatusPill';

/** A titled card of the dashboard; the heading names the section for screen readers. */
export function DashboardSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-xl border px-5 py-4">
      <div className="space-y-1">
        <h2 id={id} className="text-base font-medium">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** One number with its label; `outdated` adds an "Out of date" pill (text, not colour alone). */
export function Stat({
  label,
  value,
  detail,
  outdated = false,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  outdated?: boolean;
}) {
  return (
    <div className="space-y-1 rounded-lg border px-4 py-3">
      <dt className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {label}
        {outdated && <StatusPill tone="review">Out of date</StatusPill>}
      </dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      {detail && <dd className="text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}

/** A simple table with a caption, header row and body rows (cells already formatted). */
export function DataTable({
  caption,
  headers,
  rows,
  hiddenCaption = true,
  className,
}: {
  caption: string;
  headers: string[];
  rows: { key: string; cells: ReactNode[] }[];
  hiddenCaption?: boolean;
  className?: string;
}) {
  return (
    <div className={className ?? 'overflow-x-auto rounded-lg border'}>
      <table className="w-full text-left text-sm">
        <caption className={hiddenCaption ? 'sr-only' : 'pb-2 text-left text-sm font-medium'}>
          {caption}
        </caption>
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col" className="px-3 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t">
              {row.cells.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-3 py-2.5 font-normal">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="px-3 py-2.5 tabular-nums">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
