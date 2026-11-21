import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';

import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import type { ColumnMapping, MappingRole, TargetField } from '@/lib/api-types';

import {
  CONFIDENCE_TONES,
  confidenceText,
  formatConfidence,
  STATUS_LABELS,
  STATUS_TONES,
  targetLabel,
  transformLabel,
} from './mapping-labels';

function TargetCell({
  target,
  role,
  fields,
}: {
  target: string | null;
  role: MappingRole;
  fields: ReadonlyMap<string, TargetField>;
}) {
  if (role === 'field' && target !== null) {
    const description = fields.get(target)?.description;
    return (
      <div>
        <span className="font-mono">{target}</span>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    );
  }
  return (
    <div>
      <span className="text-muted-foreground">{targetLabel(target, role)}</span>
      {role === 'source_record_id' && (
        <p className="text-xs text-muted-foreground">Kept to trace records back to this file</p>
      )}
    </div>
  );
}

function Alternatives({ mapping }: { mapping: ColumnMapping }) {
  const { alternatives } = mapping.suggestion;
  return (
    <div className="space-y-1 px-4 py-3">
      <h4 className="text-xs text-muted-foreground">Other possible fields</h4>
      {alternatives.length === 0 ? (
        <p className="text-sm text-muted-foreground">No other field came close.</p>
      ) : (
        <ul className="space-y-0.5 text-sm">
          {alternatives.map((alt, index) => (
            <li key={index} className="flex gap-3">
              <span className={alt.role === 'field' ? 'font-mono' : 'text-muted-foreground'}>
                {targetLabel(alt.target, alt.role)}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {formatConfidence(alt.confidence)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {mapping.status === 'overridden' && mapping.decision && (
        <p className="pt-2 text-sm">
          <span className="text-muted-foreground">Changed by a reviewer to: </span>
          <span className="font-mono">
            {targetLabel(mapping.decision.target, mapping.decision.role)}
          </span>
        </p>
      )}
    </div>
  );
}

interface MappingTableProps {
  columns: ColumnMapping[];
  fields: ReadonlyMap<string, TargetField>;
  /** Decision buttons for a row; the Actions column is left out when not given. */
  renderActions?: ((mapping: ColumnMapping) => ReactNode) | undefined;
}

/** One row per source column; a row expands to show the other fields that were considered. */
export function MappingTable({ columns, fields, renderActions }: MappingTableProps) {
  const columnCount = renderActions ? 7 : 6;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (name: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Column mapping suggestions</caption>
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Source column
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Suggested field
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Confidence
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Why
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Cleaning
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Status
            </th>
            {renderActions && (
              <th scope="col" className="px-3 py-2.5 font-medium">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {columns.map((mapping) => {
            const { suggestion } = mapping;
            const open = expanded.has(mapping.column);
            const detailsId = `mapping-alternatives-${mapping.position}`;
            const Chevron = open ? ChevronDown : ChevronRight;
            return (
              <Fragment key={mapping.column}>
                <tr className="border-t align-top">
                  <th scope="row" className="px-1.5 py-1.5 font-normal">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto px-1.5 py-1 font-mono font-normal"
                      aria-label={`${mapping.column}, other possible fields`}
                      aria-expanded={open}
                      aria-controls={open ? detailsId : undefined}
                      onClick={() => {
                        toggle(mapping.column);
                      }}
                    >
                      <Chevron aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      {mapping.column}
                    </Button>
                  </th>
                  <td className="px-3 py-2.5">
                    <TargetCell target={suggestion.target} role={suggestion.role} fields={fields} />
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusPill tone={CONFIDENCE_TONES[suggestion.confidenceLabel]}>
                      {confidenceText(suggestion.confidenceLabel, suggestion.confidence)}
                    </StatusPill>
                  </td>
                  <td className="max-w-80 px-3 py-2.5">{suggestion.reason}</td>
                  <td className="px-3 py-2.5">{transformLabel(suggestion.transform)}</td>
                  <td className="px-3 py-2.5">
                    <StatusPill tone={STATUS_TONES[mapping.status]}>
                      {STATUS_LABELS[mapping.status]}
                    </StatusPill>
                  </td>
                  {renderActions && <td className="px-3 py-2">{renderActions(mapping)}</td>}
                </tr>
                {open && (
                  <tr id={detailsId} className="bg-muted/30">
                    <td colSpan={columnCount}>
                      <Alternatives mapping={mapping} />
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
