import { CircleAlert, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';

import { EmptyState } from '@/components/EmptyState';
import { ProgressBar } from '@/components/ProgressBar';
import { StatusPill } from '@/components/StatusPill';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjectJobs } from '@/features/sources/queries';
import { ApiError } from '@/lib/api';
import type { ClusterSummaryView, ClusterView, Job } from '@/lib/api-types';
import { isTerminalStatus } from '@/lib/job-events';

import { ClusterDetail } from './ClusterDetail';
import {
  approveHighSummary,
  clusterConfidence,
  CUSTOMER_ID_PATTERN,
  FLAG_LABELS,
  formatCount,
  plural,
  reviewStatus,
} from './matching-labels';
import {
  latestJob,
  reviewErrorMessage,
  useApproveHigh,
  useCluster,
  useClusters,
  type ClusterFilters,
} from './queries';
import { ConfirmAction } from './ReviewDialogs';

/** The clustering job a split or merge started: its progress until the groups are rebuilt. */
function RebuildProgress({ job }: { job: Job }) {
  return (
    <div role="status" className="space-y-2 rounded-xl border px-4 py-3">
      <p className="text-sm font-medium">
        {job.status === 'queued'
          ? 'Waiting to rebuild the groups'
          : `Rebuilding the groups: ${job.progress}%`}
      </p>
      <ProgressBar value={job.progress / 100} label="Rebuilding the groups" />
    </div>
  );
}

type StatusFilter = NonNullable<ClusterFilters['status']>;

function SummaryCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCount(value)}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  pressed,
  onChange,
}: {
  label: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={pressed ? 'secondary' : 'ghost'}
      aria-pressed={pressed}
      onClick={() => {
        onChange(!pressed);
      }}
    >
      {label}
    </Button>
  );
}

function LoadError({ what, message, retry }: { what: string; message: string; retry: () => void }) {
  return (
    <Alert>
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>
          We could not load {what}. {message}
        </span>
        <Button size="sm" variant="outline" onClick={retry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function ClusterTable({
  clusters,
  selectedId,
  onSelect,
}: {
  clusters: ClusterView[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Customers found</caption>
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            {['Customer ID', 'Records', 'Confidence', 'Flags', 'Status', 'Details'].map((h) => (
              <th key={h} scope="col" className="px-3 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clusters.map((cluster) => {
            const confidence = clusterConfidence(cluster);
            const open = cluster.customerId === selectedId;
            return (
              <tr key={cluster.customerId} className="border-t align-top">
                <th scope="row" className="px-3 py-2.5 font-mono font-normal">
                  {cluster.customerId}
                </th>
                <td className="px-3 py-2.5 tabular-nums">{cluster.size}</td>
                <td className="px-3 py-2.5">
                  <StatusPill tone={confidence.tone}>{confidence.text}</StatusPill>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {cluster.flags.map((flag) => (
                      <StatusPill key={flag} tone="review">
                        {FLAG_LABELS[flag]}
                      </StatusPill>
                    ))}
                    {cluster.aiSuggested && <StatusPill tone="neutral">AI suggested</StatusPill>}
                  </div>
                  {cluster.reasons.length > 0 && (
                    <p className="mt-1 max-w-72 text-xs text-muted-foreground">
                      {cluster.reasons.join(' ')}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill tone={reviewStatus(cluster).tone}>
                    {reviewStatus(cluster).text}
                  </StatusPill>
                </td>
                <td className="px-3 py-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={open ? 'secondary' : 'outline'}
                    aria-expanded={open}
                    aria-label={`Details for ${cluster.customerId}`}
                    onClick={() => {
                      onSelect(open ? null : cluster.customerId);
                    }}
                  >
                    {open ? 'Hide' : 'View'}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Summary cards, filters, the list of proposed customers and the open one's details. */
export function ClustersSection({
  projectId,
  view,
  canDecide,
}: {
  projectId: string;
  view: ClusterSummaryView;
  /** Approve, split and merge (data stewards and up); viewers only read. */
  canDecide: boolean;
}) {
  const [needsReview, setNeedsReview] = useState(false);
  const [aiOnly, setAiOnly] = useState(false);
  const [multiOnly, setMultiOnly] = useState(true);
  const [status, setStatus] = useState<StatusFilter | null>(null);
  const [result, setResult] = useState('');
  const jobs = useProjectJobs(projectId);
  const approveHigh = useApproveHigh(projectId);
  const clustering = latestJob(jobs.data, 'clustering');
  const rebuilding =
    clustering !== null && !isTerminalStatus(clustering.status) ? clustering : null;
  const [cursors, setCursors] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [queryError, setQueryError] = useState<string | null>(null);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // `?customer=<id>` (from an assistant source, a shared link or a search) opens that customer,
  // fetched by id so it need not be on the current page. Applied when the URL changes to an id
  // other than the one shown (a search here writes the URL too, so it is not applied twice).
  const [params, setParams] = useSearchParams();
  const linked = params.get('customer');
  const linkedId = linked?.trim().toUpperCase() ?? '';
  const linkValid = CUSTOMER_ID_PATTERN.test(linkedId);
  const [seenLink, setSeenLink] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  if (linked !== seenLink) {
    setSeenLink(linked);
    if (linkValid && linkedId !== searchId) {
      setQuery(linkedId);
      setQueryError(null);
      setSearchId(linkedId);
      setSelectedId(linkedId);
      setFocusId(linkedId);
    }
  }
  const setLink = (id: string | null) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id === null) next.delete('customer');
        else next.set('customer', id);
        return next;
      },
      { replace: true },
    );
  };

  const filters: ClusterFilters = {
    ...(needsReview ? { flag: 'needs_review' as const } : {}),
    ...(multiOnly ? { minSize: 2 } : {}),
    ...(aiOnly ? { aiSuggested: true } : {}),
    ...(status ? { status } : {}),
    ...(cursors.length > 0 ? { cursor: cursors[cursors.length - 1] } : {}),
  };
  const list = useClusters(projectId, filters, searchId === null);
  const found = useCluster(projectId, searchId);
  const { summary, review } = view;

  const changeFilter = (set: (v: boolean) => void) => (value: boolean) => {
    set(value);
    setCursors([]);
    setSelectedId(null);
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    const id = query.trim().toUpperCase();
    if (!id) {
      setSearchId(null);
      setQueryError(null);
      setLink(null);
      return;
    }
    if (!CUSTOMER_ID_PATTERN.test(id)) {
      setQueryError('Enter a customer id such as C1A2B3C4D5E6F.');
      return;
    }
    setQueryError(null);
    setSearchId(id);
    setSelectedId(id);
    setLink(id);
  };

  let rows: ClusterView[] = [];
  let body;
  if (searchId !== null) {
    if (found.isPending) body = <Skeleton className="h-24 w-full" aria-label="Searching" />;
    else if (found.isError) {
      body =
        found.error instanceof ApiError && found.error.status === 404 ? (
          <EmptyState
            title={`No customer ${searchId}`}
            description="Check the id, or clear the search to see every customer."
            className="py-10"
          />
        ) : (
          <LoadError
            what="this customer"
            message={found.error.message}
            retry={() => void found.refetch()}
          />
        );
    } else rows = [found.data.cluster];
  } else if (list.isPending) {
    body = <Skeleton className="h-40 w-full" aria-label="Loading customers" />;
  } else if (list.isError) {
    body = (
      <LoadError
        what="the customers"
        message={list.error.message}
        retry={() => void list.refetch()}
      />
    );
  } else {
    rows = list.data.items;
    if (rows.length === 0) {
      body = (
        <EmptyState
          title="No customers match these filters"
          description="Try turning a filter off."
          className="py-10"
        />
      );
    }
  }
  const selected = rows.find((c) => c.customerId === selectedId) ?? null;
  const nextCursor = searchId === null && list.isSuccess ? list.data.nextCursor : null;

  return (
    <section aria-labelledby="customers-found" className="space-y-5">
      <h2 id="customers-found" className="text-base font-medium">
        Customers found
      </h2>
      {view.outdated && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>These groups are out of date</AlertTitle>
          <AlertDescription>
            The pairs were scored or reviewed again after grouping. Re-run “Group records” to see
            the latest result.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryCard
          label="People found"
          value={summary.clusterCount}
          hint={`from ${formatCount(summary.recordCount)} records`}
        />
        <SummaryCard
          label="Records merged"
          value={summary.multiRecordCount}
          hint="groups of 2 or more"
        />
        <SummaryCard label="Need review" value={summary.needsReviewCount} />
        <SummaryCard label="AI suggested" value={summary.aiSuggestedCount} />
        <SummaryCard label="Largest group" value={summary.largestCluster} hint="records" />
        <SummaryCard
          label="Approved"
          value={review.approvedCount}
          hint={`${formatCount(review.proposedCount)} still proposed`}
        />
      </div>
      {summary.staleDecisionCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {plural(
            summary.staleDecisionCount,
            'earlier decision no longer applies',
            'earlier decisions no longer apply',
          )}
          : their records were changed or removed.
        </p>
      )}
      {rebuilding && <RebuildProgress job={rebuilding} />}
      <p aria-live="polite" role="status" className="text-sm empty:hidden">
        {result}
      </p>
      {canDecide && (
        <div className="flex flex-wrap items-center gap-3">
          <ConfirmAction
            label="Approve all High"
            variant="default"
            title={`Approve ${plural(review.approvableHighCount, 'High-confidence group', 'High-confidence groups')}?`}
            description="Approves every group of 2 or more records with High confidence and no review flag that is not approved yet. You can undo any of them afterwards."
            confirmLabel={`Approve ${formatCount(review.approvableHighCount)}`}
            pending={approveHigh.isPending}
            disabled={review.approvableHighCount === 0 || rebuilding !== null || view.outdated}
            onConfirm={() => {
              approveHigh.mutate(undefined, {
                onSuccess: (counts) => {
                  setResult(approveHighSummary(counts));
                },
                onError: (error) => {
                  setResult(reviewErrorMessage(error));
                },
              });
            }}
          />
          {review.approvableHighCount === 0 && (
            <span className="text-sm text-muted-foreground">
              No High-confidence groups are waiting for approval.
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <form role="search" onSubmit={search} className="flex items-start gap-2">
          <div className="relative w-64">
            <Label htmlFor="customer-search" className="sr-only">
              Search by customer id
            </Label>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="customer-search"
              type="search"
              placeholder="Customer id, e.g. C1A2B3C4D5E6F"
              className="pl-8"
              value={query}
              aria-invalid={queryError !== null}
              aria-describedby={queryError ? 'customer-search-error' : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
          {searchId !== null && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery('');
                setSearchId(null);
                setSelectedId(null);
                setLink(null);
              }}
            >
              Clear search
            </Button>
          )}
        </form>
        {searchId === null && (
          <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-sm text-muted-foreground">Show only:</span>
            <Toggle
              label="Needs review"
              pressed={needsReview}
              onChange={changeFilter(setNeedsReview)}
            />
            <Toggle label="AI suggested" pressed={aiOnly} onChange={changeFilter(setAiOnly)} />
            <Toggle
              label="Approved"
              pressed={status === 'approved'}
              onChange={changeFilter((on) => {
                setStatus(on ? 'approved' : null);
              })}
            />
            <Toggle
              label="Not approved"
              pressed={status === 'proposed'}
              onChange={changeFilter((on) => {
                setStatus(on ? 'proposed' : null);
              })}
            />
            <Toggle
              label="2 or more records"
              pressed={multiOnly}
              onChange={changeFilter(setMultiOnly)}
            />
          </div>
        )}
      </div>
      {queryError && (
        <p id="customer-search-error" className="text-sm text-destructive">
          {queryError}
        </p>
      )}
      {linked !== null && !linkValid && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>This link does not name a valid customer</AlertTitle>
          <AlertDescription>
            Customer ids look like C1A2B3C4D5E6F. Search for the customer above, or browse the list
            below.
          </AlertDescription>
        </Alert>
      )}

      {body ?? <ClusterTable clusters={rows} selectedId={selectedId} onSelect={setSelectedId} />}

      {searchId === null && (cursors.length > 0 || nextCursor !== null) && (
        <nav aria-label="Pages" className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={cursors.length === 0}
            onClick={() => {
              setCursors((c) => c.slice(0, -1));
              setSelectedId(null);
            }}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {cursors.length + 1}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={nextCursor === null}
            onClick={() => {
              if (nextCursor !== null) setCursors((c) => [...c, nextCursor]);
              setSelectedId(null);
            }}
          >
            Next
          </Button>
        </nav>
      )}

      {selected && (
        <ClusterDetail
          key={selected.customerId}
          projectId={projectId}
          cluster={selected}
          canDecide={canDecide}
          rebuilding={rebuilding !== null}
          focusOnOpen={selected.customerId === focusId}
          onClose={() => {
            setSelectedId(null);
          }}
          onResult={setResult}
        />
      )}
    </section>
  );
}
