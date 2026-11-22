import { ChevronDown, ChevronRight, CircleAlert } from 'lucide-react';
import { useState } from 'react';

import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { formatConfidence } from '@/features/mapping/mapping-labels';
import type {
  CandidateRecord,
  ClusterDetailView,
  ClusterView,
  FieldProvenance,
  LinkEvidence,
} from '@/lib/api-types';

import {
  AI_DECISION_LABELS,
  BAND_LABELS,
  clusterConfidence,
  FLAG_LABELS,
  LINK_KIND_LABELS,
  plural,
  recordLabel,
  reviewStatus,
  RULE_LABELS,
} from './matching-labels';
import {
  reviewErrorMessage,
  useApproveCluster,
  useCluster,
  useMergeClusters,
  useSplitRecord,
  useUndoApproval,
} from './queries';
import { ConfirmAction, MergeDialog } from './ReviewDialogs';

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

function Evidence({ evidence }: { evidence: LinkEvidence }) {
  return (
    <span className="block text-xs text-muted-foreground">
      {BAND_LABELS[evidence.band]}
      {evidence.reasons.length > 0 && <> · {evidence.reasons.map((r) => r.text).join(', ')}</>}
      {evidence.aiDecision && (
        <>
          {' · '}
          {AI_DECISION_LABELS[evidence.aiDecision]}
          {evidence.aiConfidence !== null && ` (${formatConfidence(evidence.aiConfidence)})`}
          {evidence.aiReason && <>: “{evidence.aiReason}”</>}
        </>
      )}
    </span>
  );
}

export interface ClusterDetailProps {
  projectId: string;
  cluster: ClusterView;
  /** Approve, split and merge are offered (data stewards and up). */
  canDecide: boolean;
  /** A clustering job is running: decisions wait for it. */
  rebuilding: boolean;
  onClose: () => void;
  /** A decision's outcome (or error) in plain words, announced by the section. */
  onResult: (message: string) => void;
}

/** One customer: its records side by side, the golden record and the links between them. */
export function ClusterDetail({
  projectId,
  cluster: fromList,
  canDecide,
  rebuilding,
  onClose,
  onResult,
}: ClusterDetailProps) {
  // The detail adds the evidence behind each link; the list's copy shows meanwhile.
  const detail = useCluster(projectId, fromList.customerId);
  const cluster: ClusterView | ClusterDetailView = detail.data?.cluster ?? fromList;
  const approve = useApproveCluster(projectId);
  const undo = useUndoApproval(projectId);
  const split = useSplitRecord(projectId);
  const merge = useMergeClusters(projectId);
  const pending = approve.isPending || undo.isPending || split.isPending || merge.isPending;
  const blocked = rebuilding || pending;
  const status = reviewStatus(cluster);
  const fail = (error: unknown) => {
    onResult(reviewErrorMessage(error));
  };
  const rebuilt = (what: string) => (result: { jobMessage: string | null }) => {
    onResult(result.jobMessage ?? `${what} The groups are being rebuilt.`);
  };
  const evidenceOf = (link: ClusterView['links'][number]): LinkEvidence | null =>
    'evidence' in link ? (link as ClusterDetailView['links'][number]).evidence : null;

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
            <StatusPill tone={status.tone}>{status.text}</StatusPill>
          </h3>
          {cluster.membershipChanged && (
            <p className="text-sm text-muted-foreground">
              Membership changed since approval: some of these records were in a group someone
              approved. Check it and approve again.
            </p>
          )}
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
        <div className="flex flex-wrap items-center gap-2">
          {canDecide && cluster.status !== 'approved' && (
            <Button
              type="button"
              size="sm"
              disabled={blocked}
              onClick={() => {
                approve.mutate(cluster.customerId, {
                  onSuccess: () => {
                    onResult(`Approved customer ${cluster.customerId}.`);
                  },
                  onError: fail,
                });
              }}
            >
              Approve group
            </Button>
          )}
          {canDecide && cluster.status === 'approved' && (
            <ConfirmAction
              label="Undo approval"
              title="Undo this approval?"
              description="The group goes back to Proposed. Nothing else changes."
              confirmLabel="Undo approval"
              pending={undo.isPending}
              disabled={blocked}
              onConfirm={() => {
                undo.mutate(cluster.customerId, {
                  onSuccess: () => {
                    onResult(`Customer ${cluster.customerId} is proposed again.`);
                  },
                  onError: fail,
                });
              }}
            />
          )}
          {canDecide && (
            <MergeDialog
              projectId={projectId}
              customerId={cluster.customerId}
              size={cluster.size}
              pending={merge.isPending}
              disabled={blocked}
              onConfirm={(otherId, reason) => {
                merge.mutate(
                  { customerIds: [cluster.customerId, otherId], ...(reason ? { reason } : {}) },
                  { onSuccess: rebuilt('Merge saved.'), onError: fail },
                );
              }}
            />
          )}
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Close details
          </Button>
        </div>
      </div>
      {canDecide && rebuilding && (
        <p className="text-sm text-muted-foreground">
          The groups are being rebuilt. You can decide again when that finishes.
        </p>
      )}

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
                      {canDecide && cluster.size > 1 && (
                        <span className="mt-1 block">
                          <ConfirmAction
                            label="Split out"
                            ariaLabel={`Split out ${recordLabel(member)}`}
                            title="Split this record out?"
                            description={`${recordLabel(member)} will be marked as a different person from the other ${plural(cluster.size - 1, 'record', 'records')}, and the groups are rebuilt.`}
                            confirmLabel="Split out"
                            withReason
                            variant="ghost"
                            pending={split.isPending}
                            disabled={blocked}
                            onConfirm={(reason) => {
                              split.mutate(
                                {
                                  customerId: cluster.customerId,
                                  recordId: member.id,
                                  ...(reason ? { reason } : {}),
                                },
                                { onSuccess: rebuilt('Split saved.'), onError: fail },
                              );
                            }}
                          />
                        </span>
                      )}
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
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-accent-foreground">
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
            {cluster.links.map((link) => {
              const evidence = evidenceOf(link);
              return (
                <li key={`${link.recordA}-${link.recordB}`}>
                  {labelOf(link.recordA)} and {labelOf(link.recordB)}:{' '}
                  <span className="font-medium">{formatConfidence(link.score)} match score</span>
                  {' · '}
                  {LINK_KIND_LABELS[link.kind]}
                  {!link.tree && (
                    <span className="text-muted-foreground"> · extra link, not needed to join</span>
                  )}
                  {evidence && <Evidence evidence={evidence} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
