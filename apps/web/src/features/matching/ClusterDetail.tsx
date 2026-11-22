import { ChevronDown, ChevronRight, CircleAlert } from 'lucide-react';
import { useState } from 'react';

import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { formatConfidence } from '@/features/mapping/mapping-labels';
import type { CandidateRecord, ClusterView, FieldProvenance } from '@/lib/api-types';

import {
  clusterConfidence,
  FLAG_LABELS,
  LINK_KIND_LABELS,
  plural,
  recordLabel,
  RULE_LABELS,
} from './matching-labels';

const GOLDEN_ID_FIELD = 'customer_id';

/** Target fields in golden-record order, then any only the members have. */
function fieldNames(cluster: ClusterView): string[] {
  const names = new Set(Object.keys(cluster.goldenRecord?.fields ?? {}));
  for (const member of cluster.members) {
    for (const name of Object.keys(member?.fields ?? {})) names.add(name);
  }
  names.delete(GOLDEN_ID_FIELD);
  return [...names];
}

function Empty() {
  return <span className="text-muted-foreground">Empty</span>;
}

function provenanceText(
  provenance: FieldProvenance | undefined,
  byId: ReadonlyMap<string, CandidateRecord>,
): string {
  if (!provenance?.recordId) return 'No record has this field';
  const record = byId.get(provenance.recordId);
  const from = record ? recordLabel(record) : (provenance.source ?? 'a member record');
  return provenance.rule ? `From ${from} · ${RULE_LABELS[provenance.rule]}` : `From ${from}`;
}

function Alternatives({ field, provenance }: { field: string; provenance: FieldProvenance }) {
  const [open, setOpen] = useState(false);
  const id = `alternatives-${field}`;
  const count = provenance.alternatives.length;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto px-1 py-0.5 text-xs font-normal"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${field}: all ${count} values`}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <Chevron aria-hidden="true" className="size-3" />
        All {count} values
      </Button>
      {open && (
        <ul id={id} className="mt-1 space-y-0.5 text-xs">
          {provenance.alternatives.map((alt) => (
            <li key={alt.value}>
              <span className="font-medium">{alt.value}</span>{' '}
              <span className="text-muted-foreground">
                · {plural(alt.count, 'record', 'records')} ({alt.sources.join(', ')})
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One customer: its records side by side, the golden record and the links between them. */
export function ClusterDetail({ cluster, onClose }: { cluster: ClusterView; onClose: () => void }) {
  const byId = new Map(
    cluster.members.filter((m): m is CandidateRecord => m !== null).map((m) => [m.id, m]),
  );
  const golden = cluster.goldenRecord;
  const fields = fieldNames(cluster);
  const confidence = clusterConfidence(cluster);
  const headingId = `cluster-${cluster.customerId}`;
  const labelOf = (id: string) => {
    const record = byId.get(id);
    return record ? recordLabel(record) : 'A removed record';
  };

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-xl border px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-medium">
            Customer <span className="font-mono">{cluster.customerId}</span>
            <StatusPill tone={confidence.tone}>{confidence.text}</StatusPill>
          </h3>
          <p className="text-sm text-muted-foreground">
            {plural(cluster.size, 'record', 'records')} · Differences from the golden record are
            marked “Differs”.
          </p>
          {cluster.flags.length > 0 && (
            <ul className="space-y-0.5 text-sm">
              {cluster.flags.map((flag, i) => (
                <li key={flag}>
                  <span className="font-medium">{FLAG_LABELS[flag]}</span>
                  {cluster.reasons[i] && <>: {cluster.reasons[i]}</>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Close details
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Records of customer {cluster.customerId}</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Field
              </th>
              {cluster.members.map((member, i) => (
                <th
                  key={cluster.memberRecordIds[i] ?? i}
                  scope="col"
                  className="px-3 py-2.5 font-medium"
                >
                  {member ? (
                    <>
                      <span className="block text-foreground">{member.sourceName}</span>
                      <span className="block font-normal">
                        Row {member.rowNumber}
                        {member.sourceRecordId && ` · ID ${member.sourceRecordId}`}
                      </span>
                    </>
                  ) : (
                    'Record no longer available'
                  )}
                </th>
              ))}
              <th scope="col" className="px-3 py-2.5 font-medium text-foreground">
                Golden record
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => {
              const value = golden?.fields[field] ?? null;
              const provenance = golden?.provenance[field];
              return (
                <tr key={field} className="border-t align-top">
                  <th scope="row" className="px-3 py-2.5 font-mono font-normal">
                    {field}
                  </th>
                  {cluster.members.map((member, i) => {
                    const own = member?.fields[field] ?? null;
                    const differs = golden !== null && own !== null && own !== value;
                    return (
                      <td
                        key={cluster.memberRecordIds[i] ?? i}
                        className={differs ? 'bg-accent px-3 py-2.5' : 'px-3 py-2.5'}
                      >
                        {own ?? <Empty />}
                        {differs && (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <CircleAlert aria-hidden="true" className="size-3" />
                            Differs
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5">
                    {golden === null ? (
                      <Empty />
                    ) : (
                      <>
                        <span className="font-medium">{value ?? <Empty />}</span>
                        <span className="block text-xs text-muted-foreground">
                          {provenanceText(provenance, byId)}
                        </span>
                        {provenance && provenance.alternatives.length > 1 && (
                          <Alternatives field={field} provenance={provenance} />
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {golden === null && (
        <p className="text-sm text-muted-foreground">
          No golden record was proposed for this group.
        </p>
      )}

      {cluster.links.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">Why these records are grouped</h4>
          <ul className="space-y-1 text-sm">
            {cluster.links.map((link) => (
              <li key={`${link.recordA}-${link.recordB}`}>
                {labelOf(link.recordA)} and {labelOf(link.recordB)}:{' '}
                <span className="font-medium">{formatConfidence(link.score)} match score</span>
                {' · '}
                {LINK_KIND_LABELS[link.kind]}
                {!link.tree && (
                  <span className="text-muted-foreground"> · extra link, not needed to join</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
