import type { SourceFormat } from '../modules/sources/source.types.js';

/** Everything stored for one project lives under this prefix (deleted with the project). */
export function projectPrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

/** The original upload of one source. Built from server ids only, never from the filename. */
export function sourceFileKey(projectId: string, sourceId: string, format: SourceFormat): string {
  return `${projectPrefix(projectId)}sources/${sourceId}/original.${format}`;
}
