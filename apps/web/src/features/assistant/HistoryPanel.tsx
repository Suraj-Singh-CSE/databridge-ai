import { CircleAlert, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { LoadFailed } from '@/components/LoadFailed';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { AssistantConversationSummary } from '@/lib/api-types';

import { askErrorText } from './assistant-labels';
import { useConversations, useDeleteConversation } from './queries';

function DeleteConversationDialog({
  projectId,
  conversation,
  onClose,
  onDeleted,
}: {
  projectId: string;
  conversation: AssistantConversationSummary | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const remove = useDeleteConversation(projectId);
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open={conversation !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this conversation?</DialogTitle>
          <DialogDescription>
            &ldquo;{conversation?.title}&rdquo; and its answers will be deleted. This cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        {remove.isError && (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{askErrorText(remove.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Keep it
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (!conversation) return;
              remove.mutate(conversation.id, {
                onSuccess: () => {
                  onDeleted(conversation.id);
                  close();
                },
              });
            }}
          >
            {remove.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            Delete conversation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The user's own conversations: open one, delete one, or start a new one. */
export function HistoryPanel({
  projectId,
  activeId,
  onOpen,
  onNew,
  onDeleted,
}: {
  projectId: string;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
}) {
  const conversations = useConversations(projectId);
  const [toDelete, setToDelete] = useState<AssistantConversationSummary | null>(null);

  let list;
  if (conversations.isPending) {
    list = <Skeleton className="h-24 w-full" aria-label="Loading your conversations" />;
  } else if (conversations.isError) {
    list = (
      <LoadFailed
        title="We could not load your conversations"
        message={conversations.error.message}
        retry={() => void conversations.refetch()}
      />
    );
  } else if (conversations.data.length === 0) {
    list = <p className="text-sm text-muted-foreground">Your questions will appear here.</p>;
  } else {
    list = (
      <ul aria-label="Your conversations" className="space-y-1">
        {conversations.data.map((item) => (
          <li key={item.id} className="flex items-center gap-1">
            <button
              type="button"
              aria-current={item.id === activeId || undefined}
              aria-label={`Open conversation: ${item.title}`}
              onClick={() => {
                onOpen(item.id);
              }}
              className="group min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-[current=true]:bg-muted"
            >
              <span className="block truncate">{item.title}</span>
              <span className="block text-xs text-muted-foreground group-hover:text-foreground group-aria-[current=true]:text-foreground">
                <TimeAgo iso={item.updatedAt} />
              </span>
            </button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Delete conversation: ${item.title}`}
              onClick={() => {
                setToDelete(item);
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="assistant-history" className="space-y-3 rounded-xl border px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="assistant-history" className="text-base font-medium">
          History
        </h2>
        <Button type="button" size="sm" variant="outline" onClick={onNew}>
          <Plus aria-hidden="true" />
          New conversation
        </Button>
      </div>
      {list}
      <DeleteConversationDialog
        projectId={projectId}
        conversation={toDelete}
        onClose={() => {
          setToDelete(null);
        }}
        onDeleted={onDeleted}
      />
    </section>
  );
}
