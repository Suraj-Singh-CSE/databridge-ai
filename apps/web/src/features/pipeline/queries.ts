import { useMutation, useQuery } from '@tanstack/react-query';

import { api, downloadFile } from '@/lib/api';
import type { ExportView, SqlVersion, SqlVersionSummary } from '@/lib/api-types';

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
