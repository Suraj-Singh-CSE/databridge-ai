import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { sourceKeys } from '@/features/sources/queries';
import { api } from '@/lib/api';
import type {
  AssistantConversation,
  AssistantConversationSummary,
  AssistantReply,
  KnowledgeSummary,
} from '@/lib/api-types';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const conversationPath = (projectId: string, id: string) =>
  `${projectPath(projectId)}/assistant/conversations/${encodeURIComponent(id)}`;

export const assistantKeys = {
  all: sourceKeys.assistant,
  summary: (projectId: string) => [...assistantKeys.all(projectId), 'summary'] as const,
  conversations: (projectId: string) => [...assistantKeys.all(projectId), 'conversations'] as const,
};

/** The project's knowledge index summary; null until the first `knowledge_index` job ends. */
export function useKnowledgeSummary(projectId: string) {
  return useQuery({
    queryKey: assistantKeys.summary(projectId),
    queryFn: ({ signal }) =>
      api<{ summary: KnowledgeSummary | null }>(`${projectPath(projectId)}/knowledge/summary`, {
        signal,
      }).then((data) => data.summary),
  });
}

/** The signed-in user's own conversations, newest first. */
export function useConversations(projectId: string) {
  return useQuery({
    queryKey: assistantKeys.conversations(projectId),
    queryFn: ({ signal }) =>
      api<{ items: AssistantConversationSummary[] }>(
        `${projectPath(projectId)}/assistant/conversations?limit=50`,
        { signal },
      ).then((data) => data.items),
  });
}

/** Reads one conversation with its turns (opened from the history list). */
export function useOpenConversation(projectId: string) {
  return useMutation({
    mutationFn: (id: string) =>
      api<{ conversation: AssistantConversation }>(conversationPath(projectId, id)).then(
        (data) => data.conversation,
      ),
  });
}

/** Asks a question; the history list is re-read so a new conversation appears in it. */
export function useAsk(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { question: string; conversationId?: string }) =>
      api<AssistantReply>(`${projectPath(projectId)}/assistant/ask`, { method: 'POST', body }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assistantKeys.conversations(projectId) }),
  });
}

export function useDeleteConversation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(conversationPath(projectId, id), { method: 'DELETE' }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assistantKeys.conversations(projectId) }),
  });
}
