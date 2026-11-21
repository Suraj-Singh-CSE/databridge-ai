import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';

import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { formatPercent } from '@/features/sources/source-rules';
import type { ColumnProfile } from '@/lib/api-types';

import { flagTone, TYPE_LABELS } from './profile-labels';

export type EmptySort = 'none' | 'desc' | 'asc';

const NEXT_SORT: Record<EmptySort, EmptySort> = { none: 'desc', desc: 'asc', asc: 'none' };
const ARIA_SORT = { none: 'none', desc: 'descending', asc: 'ascending' } as const;

function EmptyBar({ percent }: { percent: number }) {
  return (
    <div className="flex items-center gap-2">
      <div aria-hidden="true" className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/60"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <span className="tabular-nums">{formatPercent(percent)}</span>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function valueText(value: number | string | null): string {
  if (value === null) return '—';
  return typeof value === 'number' ? value.toLocaleString('en-US') : value;
}

function ColumnDetails({ column }: { column: ColumnProfile }) {
  const lengths =
    column.minLength === null
      ? '—'
      : `${column.minLength} to ${column.maxLength ?? '—'} characters (average ${column.avgLength ?? '—'})`;
  return (
    <div className="grid gap-5 px-4 py-4 md:grid-cols-2">
      <dl className="grid grid-cols-2 gap-4">
        <Detail label="Smallest value">
          {column.personal ? 'Hidden (personal data)' : valueText(column.min)}
        </Detail>
        <Detail label="Largest value">
          {column.personal ? 'Hidden (personal data)' : valueText(column.max)}
        </Detail>
        <Detail label="Length">{lengths}</Detail>
        <Detail label="Values">
          {column.rowCount.toLocaleString('en-US')} rows,{' '}
          {column.emptyCount.toLocaleString('en-US')} empty,{' '}
          {column.distinctCount.toLocaleString('en-US')} different
        </Detail>
        {column.flags.length > 0 && (
          <div className="col-span-2 space-y-1">
            <dt className="text-xs text-muted-foreground">Why it is flagged</dt>
            <dd>
              <ul className="space-y-0.5 text-sm">
                {column.flags.map((flag) => (
                  <li key={flag.code}>
                    <span className="font-medium">{flag.label}:</span> {flag.detail}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
      <div className="space-y-4">
        <div className="space-y-1">
          <h4 className="text-xs text-muted-foreground">Most common values (masked)</h4>
          {column.topValues.length === 0 ? (
            <p className="text-sm text-muted-foreground">None</p>
          ) : (
            <ul className="space-y-0.5 text-sm">
              {column.topValues.map((top) => (
                <li key={top.value} className="flex justify-between gap-3">
                  <span className="truncate font-mono">{top.value}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {top.count.toLocaleString('en-US')} · {formatPercent(top.percent)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-1">
          <h4 className="text-xs text-muted-foreground">Sample values (masked)</h4>
          {column.samples.length === 0 ? (
            <p className="text-sm text-muted-foreground">None</p>
          ) : (
            <ul
              aria-label={`Masked samples of ${column.column}`}
              className="flex flex-wrap gap-1.5"
            >
              {column.samples.map((sample) => (
                <li key={sample} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                  {sample}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

interface ColumnProfileTableProps {
  columns: ColumnProfile[];
  sort: EmptySort;
  onSortChange: (sort: EmptySort) => void;
}

/** One row per column; a row expands to show ranges, lengths, top values and masked samples. */
export function ColumnProfileTable({ columns, sort, onSortChange }: ColumnProfileTableProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (name: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const SortIcon = sort === 'desc' ? ArrowDown : sort === 'asc' ? ArrowUp : ArrowUpDown;

  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Column profile</caption>
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Column
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Type
            </th>
            <th scope="col" aria-sort={ARIA_SORT[sort]} className="px-1.5 py-1 font-medium">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-xs font-medium text-muted-foreground"
                onClick={() => {
                  onSortChange(NEXT_SORT[sort]);
                }}
              >
                Empty
                <SortIcon aria-hidden="true" className="size-3.5" />
                <span className="sr-only">, sort by empty values</span>
              </Button>
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Unique
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Patterns
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Flags
            </th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => {
            const open = expanded.has(column.column);
            const detailsId = `column-details-${column.position}`;
            const Chevron = open ? ChevronDown : ChevronRight;
            return (
              <Fragment key={column.column}>
                <tr className="border-t align-top">
                  <th scope="row" className="px-1.5 py-1.5 font-normal">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto px-1.5 py-1 font-mono font-normal"
                      aria-expanded={open}
                      aria-controls={open ? detailsId : undefined}
                      onClick={() => {
                        toggle(column.column);
                      }}
                    >
                      <Chevron aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      {column.column}
                      <span className="sr-only">, details</span>
                    </Button>
                  </th>
                  <td className="px-3 py-2.5">{TYPE_LABELS[column.inferredType]}</td>
                  <td className="px-3 py-2.5">
                    <EmptyBar percent={column.emptyPercent} />
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">
                    {formatPercent(column.uniquePercent)}
                  </td>
                  <td className="px-3 py-2.5">
                    {column.patterns.length === 0 ? (
                      <span className="text-muted-foreground">None found</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {column.patterns.map((pattern) => (
                          <li key={pattern.code}>
                            {pattern.label}{' '}
                            <span className="text-muted-foreground tabular-nums">
                              {formatPercent(pattern.matchPercent)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {column.flags.length === 0 ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1">
                        {column.flags.map((flag) => (
                          <li key={flag.code} title={flag.detail}>
                            <StatusPill tone={flagTone(flag.code)}>{flag.label}</StatusPill>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
                {open && (
                  <tr id={detailsId} className="bg-muted/30">
                    <td colSpan={6}>
                      <ColumnDetails column={column} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
