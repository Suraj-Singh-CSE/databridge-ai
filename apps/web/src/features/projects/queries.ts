import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { Page, Project, ProjectPerson, Role } from '@/lib/api-types';

/** The api caps a page at 100; more than that will need paging in the UI (not needed yet). */
const PAGE_LIMIT = 100;

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  detail: (id: string) => [...projectKeys.all, 'detail', id] as const,
  people: (id: string) => [...projectKeys.all, 'people', id] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: ({ signal }) => api<Page<Project>>(`/projects?page=1&limit=${PAGE_LIMIT}`, { signal }),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(id ?? ''),
    queryFn: ({ signal }) =>
      api<{ project: Project }>(`/projects/${encodeURIComponent(id ?? '')}`, { signal }).then(
        (data) => data.project,
      ),
    enabled: Boolean(id),
  });
}

/** Current members with display labels, for "by …" lines. Changes rarely, so cache it. */
export function useProjectPeople(id: string) {
  return useQuery({
    queryKey: projectKeys.people(id),
    queryFn: ({ signal }) =>
      api<{ people: ProjectPerson[] }>(`/projects/${encodeURIComponent(id)}/people`, {
        signal,
      }).then((data) => data.people),
    staleTime: 5 * 60_000,
  });
}

export interface NewProjectInput {
  name: string;
  description: string;
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewProjectInput) =>
      api<{ project: Project }>('/projects', { method: 'POST', body: input }).then(
        (data) => data.project,
      ),
    onSuccess: async (project) => {
      queryClient.setQueryData(projectKeys.detail(project.id), project);
      await queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}

/** Global roles allowed to create projects (the api enforces the same rule). */
export function canCreateProjects(role: Role): boolean {
  return role === 'admin' || role === 'data_engineer';
}
