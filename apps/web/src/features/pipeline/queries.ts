import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { sourceKeys, storeJob } from '@/features/sources/queries';
import { api, downloadFile } from '@/lib/api';
import type {
  DataScope,
  ExportFormat,
  ExportView,
  Job,
  SqlVersion,
  SqlVersionSummary,
} from '@/lib/api-types';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const pipelineKeys = {
  all: (projectId: string) => ['projects', projectId, 'pipeline'] as const,
  versions: (projectId: string) => [...pipelineKeys.all(projectId), 'sql', 'list'] as const,
  version: (projectId: string, versionId: string) =>
    [...pipelineKeys.all(projectId), 'sql', 'one', versionId] as const,
  exports: (projectId: string) => [...pipelineKeys.all(projectId), 'exports'] as const,
};

/** Every SQL version of the project, newest first (without the query text). */
export function useSqlVersions(projectId: string) {
  return useQuery({
    queryKey: pipelineKeys.versions(projectId),
    queryFn: ({ signal }) =>
      api<{ items: SqlVersionSummary[] }>(`${projectPath(projectId)}/sql/versions?limit=50`, {
        signal,
      }).then((data) => data.items),
  });
}

/** One version with its query text; null asks for nothing. */
export function useSqlVersion(projectId: string, versionId: string | null) {
  return useQuery({
    queryKey: pipelineKeys.version(projectId, versionId ?? ''),
    queryFn: ({ signal }) =>
      api<{ version: SqlVersion }>(
        `${projectPath(projectId)}/sql/versions/${encodeURIComponent(versionId ?? '')}`,
        { signal },
      ).then((data) => data.version),
    enabled: versionId !== null,
  });
}

export function useExports(projectId: string) {
  return useQuery({
    queryKey: pipelineKeys.exports(projectId),
    queryFn: ({ signal }) =>
      api<{ items: ExportView[] }>(`${projectPath(projectId)}/exports?limit=50`, { signal }).then(
        (data) => data.items,
      ),
  });
}

/** Hands a Blob to the browser as a file download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick, after the browser has started the download.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * Downloads an export with the bearer token (fetch, not a link) and saves it under the name
 * from Content-Disposition, falling back to the name the list gave.
 */
export function useDownloadExport(projectId: string) {
  return useMutation({
    mutationFn: async (item: ExportView) => {
      const file = await downloadFile(
        `${projectPath(projectId)}/exports/${encodeURIComponent(item.id)}/download`,
      );
      const filename = file.filename ?? item.filename;
      saveBlob(file.blob, filename);
      return filename;
    },
  });
}

/* ---------- Actions: jobs, SQL decisions, export deletion ---------- */

/** The jobs started from the Pipeline and Data quality pages, with their payloads. */
export type PipelineJobRequest =
  | { type: 'sql_draft'; payload: { scope: DataScope; instructions?: string } }
  | { type: 'sql_run'; payload: { versionId: string } }
  | { type: 'export'; payload: { format: ExportFormat; scope: DataScope; includeSources: boolean } }
  | { type: 'quality'; payload: Record<string, never> };

export type PipelineJobType = PipelineJobRequest['type'];

/** Starts a job; it goes into the cached job list so its progress shows straight away. */
export function useStartPipelineJob(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: PipelineJobRequest) =>
      api<{ job: Job }>(`${projectPath(projectId)}/jobs`, { method: 'POST', body: request }).then(
        (data) => data.job,
      ),
    onSuccess: (job) => {
      storeJob(queryClient, job);
    },
    // A 409 may mean the job is already running: fetch it so its progress shows.
    onError: () => queryClient.invalidateQueries({ queryKey: sourceKeys.jobs(projectId) }),
  });
}

/** The newest job of `type` (the list is newest first). */
export function latestJobOf(jobs: Job[] | undefined, type: PipelineJobType): Job | null {
  return jobs?.find((job) => job.type === type) ?? null;
}

const versionPath = (projectId: string, versionId: string) =>
  `${projectPath(projectId)}/sql/versions/${encodeURIComponent(versionId)}`;

/** Approve or reject; every SQL view is re-read since approving supersedes the previous one. */
function useSqlDecision<Input>(projectId: string, request: (input: Input) => Promise<SqlVersion>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pipelineKeys.all(projectId) }),
  });
}

export function useApproveSql(projectId: string) {
  return useSqlDecision(projectId, (versionId: string) =>
    api<{ version: SqlVersion }>(`${versionPath(projectId, versionId)}/approve`, {
      method: 'POST',
      body: {},
    }).then((data) => data.version),
  );
}

export function useRejectSql(projectId: string) {
  return useSqlDecision(
    projectId,
    ({ versionId, reason }: { versionId: string; reason: string | undefined }) =>
      api<{ version: SqlVersion }>(`${versionPath(projectId, versionId)}/reject`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }).then((data) => data.version),
  );
}

export function useDeleteExport(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: ExportView) =>
      api<{ deleted: true }>(`${projectPath(projectId)}/exports/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, item) => {
      queryClient.setQueryData<ExportView[]>(pipelineKeys.exports(projectId), (items) =>
        items?.filter((other) => other.id !== item.id),
      );
      return queryClient.invalidateQueries({ queryKey: pipelineKeys.exports(projectId) });
    },
  });
}
