import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, LoaderCircle, Send, ShieldCheck } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/features/auth/auth-context';
import { canManageSources, projectAccessOf } from '@/features/projects/access';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import { ApiError } from '@/lib/api';
import type { AssistantTurn, Project } from '@/lib/api-types';

import {
  MAX_QUESTION_CHARS,
  PRIVACY_NOTE,
  askErrorText,
  citedCustomerId,
  exampleQuestions,
} from './assistant-labels';
import { HistoryPanel } from './HistoryPanel';
import { KnowledgeStatus } from './KnowledgeStatus';
import { assistantKeys, useAsk, useKnowledgeSummary, useOpenConversation } from './queries';
import { TurnView } from './TurnView';

const PAGE = projectPage('assistant');

interface Thread {
  id: string | null;
  turns: AssistantTurn[];
}

const EMPTY_THREAD: Thread = { id: null, turns: [] };

function AssistantContent({ project }: { project: Project }) {
  const { user } = useAuth();
  const access = user ? projectAccessOf(project, user) : null;
  const queryClient = useQueryClient();
  const summary = useKnowledgeSummary(project.id);
  const ask = useAsk(project.id);
  const open = useOpenConversation(project.id);
  const [thread, setThread] = useState<Thread>(EMPTY_THREAD);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const notBuilt = summary.isSuccess && summary.data === null;
  const busy = ask.isPending || open.isPending;

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy || notBuilt) return;
    setError(null);
    setPending(trimmed);
    setQuestion('');
    inputRef.current?.focus();
    ask.mutate(
      thread.id ? { question: trimmed, conversationId: thread.id } : { question: trimmed },
      {
        onSuccess: (reply) => {
          setThread((current) => ({
            id: reply.conversationId,
            turns: [...current.turns, reply.turn],
          }));
        },
        onError: (e) => {
          setQuestion(trimmed);
          setError(askErrorText(e));
          if (e instanceof ApiError && e.code === 'KNOWLEDGE_NOT_BUILT') {
            void queryClient.invalidateQueries({ queryKey: assistantKeys.summary(project.id) });
          }
        },
        onSettled: () => {
          setPending(null);
          inputRef.current?.focus();
        },
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(question);
    }
  };

  const reset = () => {
    setThread(EMPTY_THREAD);
    setError(null);
    open.reset();
    inputRef.current?.focus();
  };

  return (
    <div className="space-y-6">
      <KnowledgeStatus projectId={project.id} canBuild={canManageSources(access)} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="assistant-conversation" className="space-y-4">
          <h2 id="assistant-conversation" className="sr-only">
            Conversation
          </h2>
          <div aria-live="polite" className="space-y-6">
            {open.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                Opening the conversation…
              </p>
            )}
            {open.isError && (
              <Alert>
                <CircleAlert aria-hidden="true" />
                <AlertDescription>{askErrorText(open.error)}</AlertDescription>
              </Alert>
            )}
            {thread.turns.map((turn, i) => (
              <TurnView
                key={`${thread.id ?? 'new'}-${i}`}
                id={`turn-${i}`}
                projectId={project.id}
                turn={turn}
              />
            ))}
            {pending && (
              <div className="space-y-3">
                <div className="ml-auto w-fit max-w-[85%] rounded-xl bg-muted px-4 py-2 text-sm">
                  <span className="sr-only">You asked: </span>
                  {pending}
                </div>
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                  Searching project knowledge…
                </p>
              </div>
            )}
          </div>

          {thread.turns.length === 0 && !pending && !notBuilt && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Try one of these:</p>
              <div className="flex flex-wrap gap-2">
                {exampleQuestions(citedCustomerId(thread.turns)).map((example) => (
                  <Button
                    key={example}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      send(example);
                    }}
                  >
                    {example}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <Alert role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              send(question);
            }}
          >
            <label htmlFor="assistant-question" className="text-sm font-medium">
              Ask a question about this project
            </label>
            <Textarea
              id="assistant-question"
              ref={inputRef}
              value={question}
              maxLength={MAX_QUESTION_CHARS}
              rows={3}
              disabled={notBuilt}
              aria-describedby="assistant-privacy assistant-count"
              placeholder="e.g. Why did PIN completeness fail?"
              onChange={(event) => {
                setQuestion(event.target.value);
              }}
              onKeyDown={onKeyDown}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p
                id="assistant-privacy"
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <ShieldCheck aria-hidden="true" className="size-3.5" />
                {PRIVACY_NOTE}
              </p>
              <div className="flex items-center gap-3">
                <span id="assistant-count" className="text-xs text-muted-foreground tabular-nums">
                  {question.length} / {MAX_QUESTION_CHARS}
                </span>
                <Button type="submit" disabled={busy || notBuilt || question.trim() === ''}>
                  {ask.isPending ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                  Send
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Press Enter to send, Shift+Enter for a new line.
            </p>
          </form>
        </section>

        <HistoryPanel
          projectId={project.id}
          activeId={thread.id}
          onNew={reset}
          onOpen={(id) => {
            setError(null);
            open.mutate(id, {
              onSuccess: (conversation) => {
                setThread({ id: conversation.id, turns: conversation.turns });
              },
            });
          }}
          onDeleted={(id) => {
            if (id === thread.id) reset();
          }}
        />
      </div>
    </div>
  );
}

/** Project assistant: ask about the data and decisions; answers cite their project sources. */
export function AssistantPage() {
  return (
    <ProjectPageFrame page={PAGE}>
      {(project) => <AssistantContent project={project} />}
    </ProjectPageFrame>
  );
}
