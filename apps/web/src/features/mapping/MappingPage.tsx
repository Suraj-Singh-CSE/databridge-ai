import { CircleAlert, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { EmptyState } from '@/components/EmptyState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import { useSources } from '@/features/sources/queries';
import type {
  ConfidenceLabel,
  Project,
  Source,
  SourceMappings,
  TargetField,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

import { isMappable, METHOD_LABELS } from './mapping-labels';
import { MappingTable } from './MappingTable';
import { useSourceMappings, useTargetSchema } from './queries';

const PAGE = projectPage('mapping');

type ConfidenceFilter = 'all' | ConfidenceLabel;
type StatusFilter = 'all' | 'pending' | 'decided';

const CONFIDENCE_FILTERS: { value: ConfidenceFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'High', label: 'High' },
  { value: 'Medium', label: 'Medium' },
  { value: 'Low', label: 'Low' },
];
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'decided', label: 'Decided' },
];

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString('en-US')}</p>
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <span className="mr-1 text-sm text-muted-foreground">{label}:</span>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant={option.value === value ? 'secondary' : 'ghost'}
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function SourcePicker({
  sources,
  selectedId,
  onSelect,
}: {
  sources: Source[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="group" aria-label="Choose a file" className="flex flex-wrap gap-2">
      {sources.map((source) => {
        const selected = source.id === selectedId;
        const mappable = isMappable(source);
        return (
          <Button
            key={source.id}
            type="button"
            size="sm"
            variant={selected ? 'secondary' : 'ghost'}
            aria-pressed={selected}
            disabled={!mappable}
            className={cn('font-normal', selected && 'font-medium')}
            onClick={() => {
              onSelect(source.id);
            }}
          >
            <span className="font-mono">{source.originalFilename}</span>
            {!mappable && <span className="text-muted-foreground">· Profile this file first</span>}
          </Button>
        );
      })}
    </div>
  );
}

function SuggestionsView({
  mappings,
  fields,
}: {
  mappings: SourceMappings;
  fields: ReadonlyMap<string, TargetField>;
}) {
  const [query, setQuery] = useState('');
  const [confidence, setConfidence] = useState<ConfidenceFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');

  const { columns, summary, run } = mappings;
  const needle = query.trim().toLowerCase();
  const shown = columns
    .filter((c) => !needle || c.column.toLowerCase().includes(needle))
    .filter((c) => confidence === 'all' || c.suggestion.confidenceLabel === confidence)
    .filter((c) => status === 'all' || (status === 'pending') === (c.status === 'pending'));

  return (
    <div className="space-y-5">
      {mappings.stale && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>The target schema changed after these suggestions were made</AlertTitle>
          <AlertDescription>
            Some suggested fields may no longer exist or may have a new meaning.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-4">
        <SummaryCard label="Columns" value={summary.total} />
        <SummaryCard label="High confidence" value={summary.high} />
        <SummaryCard label="Medium confidence" value={summary.medium} />
        <SummaryCard label="Low confidence" value={summary.low} />
      </div>
      <p className="text-sm text-muted-foreground">
        {summary.decided} decided · {summary.total - summary.decided} pending
        {run && (
          <>
            {' · '}Suggested by:{' '}
            <span className="text-foreground">{METHOD_LABELS[run.method]}</span>
            {run.method === 'rules' && ' (the AI step was not available, so only rules were used)'}
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative w-full max-w-xs">
          <Label htmlFor="mapping-search" className="sr-only">
            Search columns
          </Label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="mapping-search"
            type="search"
            placeholder="Search columns"
            className="pl-8"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <FilterGroup
          label="Confidence"
          options={CONFIDENCE_FILTERS}
          value={confidence}
          onChange={setConfidence}
        />
        <FilterGroup label="Status" options={STATUS_FILTERS} value={status} onChange={setStatus} />
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Showing {shown.length} of {columns.length} columns
        </p>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title="No matching columns"
          description="Try a different search or filter."
          className="py-10"
        />
      ) : (
        <MappingTable columns={shown} fields={fields} />
      )}
    </div>
  );
}

function LoadError({ what, message, retry }: { what: string; message: string; retry: () => void }) {
  return (
    <Alert>
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

function MappingContent({ project }: { project: Project }) {
  const sources = useSources(project.id);
  const schema = useTargetSchema(project.id);
  const [params, setParams] = useSearchParams();

  const list = sources.data ?? [];
  const requested = list.find((source) => source.id === params.get('source'));
  const selected = requested ?? list.find(isMappable) ?? list[0] ?? null;
  const mappable = selected !== null && isMappable(selected);
  const mappings = useSourceMappings(project.id, mappable ? selected.id : null);
  const fields = useMemo(
    () => new Map((schema.data?.fields ?? []).map((field) => [field.name, field])),
    [schema.data],
  );
  const profilePath = `/projects/${encodeURIComponent(project.id)}/profile`;

  if (sources.isPending) {
    return (
      <div role="status" aria-label="Loading mapping" className="space-y-3">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (sources.isError) {
    return (
      <LoadError
        what="the files"
        message={sources.error.message}
        retry={() => void sources.refetch()}
      />
    );
  }
  if (!selected) {
    return (
      <EmptyState
        title="No files to map yet"
        description="Upload a file on the Sources step first; once it is profiled, its columns can be mapped."
        action={
          <Button asChild variant="outline">
            <Link to={`/projects/${encodeURIComponent(project.id)}/sources`}>Go to Sources</Link>
          </Button>
        }
      />
    );
  }

  let body;
  if (!mappable) {
    body = (
      <EmptyState
        title="Profile this file first"
        description={`Mapping works from the column profile of ${selected.originalFilename}.`}
        action={
          <Button asChild variant="outline">
            <Link to={profilePath}>Go to Profile</Link>
          </Button>
        }
      />
    );
  } else if (mappings.isPending) {
    body = (
      <div role="status" aria-label="Loading suggestions" className="space-y-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (mappings.isError) {
    body = (
      <LoadError
        what="the suggestions"
        message={mappings.error.message}
        retry={() => void mappings.refetch()}
      />
    );
  } else if (mappings.data.run === null) {
    body = (
      <EmptyState
        title="No suggestions yet"
        description="Suggestions will appear here after mapping runs."
      />
    );
  } else if (mappings.data.columns.length === 0) {
    body = (
      <EmptyState
        title="No columns to map"
        description="Mapping ran but found no columns in this file."
      />
    );
  } else {
    body = <SuggestionsView key={selected.id} mappings={mappings.data} fields={fields} />;
  }

  return (
    <div className="space-y-5">
      {list.length > 1 ? (
        <SourcePicker
          sources={list}
          selectedId={selected.id}
          onSelect={(id) => {
            setParams({ source: id }, { replace: true });
          }}
        />
      ) : (
        <p className="text-sm">
          <span className="text-muted-foreground">File: </span>
          <span className="font-mono">{selected.originalFilename}</span>
        </p>
      )}
      {body}
    </div>
  );
}

/** Step 3: how each source column maps to the target schema (read-only review). */
export function MappingPage() {
  return (
    <ProjectPageFrame page={PAGE}>
      {(project) => <MappingContent project={project} />}
    </ProjectPageFrame>
  );
}
