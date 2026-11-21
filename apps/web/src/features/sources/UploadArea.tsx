import { CircleAlert, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';

import { ProgressBar } from '@/components/ProgressBar';
import { Button } from '@/components/ui/button';
import type { Source } from '@/lib/api-types';
import { uploadForm } from '@/lib/upload';
import { cn } from '@/lib/utils';

import {
  ACCEPTED_EXTENSIONS,
  checkFile,
  formatBytes,
  MAX_SOURCES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_ROWS,
  roomLeft,
  uploadErrorMessage,
} from './source-rules';

interface Upload {
  key: number;
  file: File;
  /** 0..1 */
  progress: number;
  controller: AbortController;
}

interface Problem {
  key: number;
  message: string;
}

interface UploadAreaProps {
  projectId: string;
  /** Sources already in the project (for the per-project limit). */
  sourceCount: number;
  onUploaded: (source: Source) => void;
}

let nextKey = 1;

/**
 * Drag-and-drop area plus a "Browse files" button (keyboard users never need to drag). Each file
 * is checked here first, then sent with real progress and a Cancel button. Problems are listed
 * in plain language under the area until dismissed.
 */
export function UploadArea({ projectId, sourceCount, onUploaded }: UploadAreaProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(new Set<AbortController>());

  // Leaving the page cancels uploads still in flight.
  useEffect(() => {
    mounted.current = true;
    const controllers = inFlight.current;
    return () => {
      mounted.current = false;
      for (const controller of controllers) controller.abort();
    };
  }, []);

  const addProblem = (message: string) => {
    setProblems((list) => [...list, { key: nextKey++, message }]);
  };

  async function send(upload: Upload) {
    const form = new FormData();
    form.append('file', upload.file);
    try {
      const { source } = await uploadForm<{ source: Source }>(
        `/projects/${encodeURIComponent(projectId)}/sources`,
        form,
        {
          signal: upload.controller.signal,
          onProgress: (progress) => {
            setUploads((list) =>
              list.map((item) => (item.key === upload.key ? { ...item, progress } : item)),
            );
          },
        },
      );
      if (!mounted.current) return;
      setAnnouncement(`${upload.file.name} uploaded.`);
      onUploaded(source);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        setAnnouncement(`Upload of ${upload.file.name} cancelled.`);
      } else {
        addProblem(`${upload.file.name}: ${uploadErrorMessage(error)}`);
        setAnnouncement(`Upload of ${upload.file.name} failed.`);
      }
    } finally {
      inFlight.current.delete(upload.controller);
      if (mounted.current) setUploads((list) => list.filter((item) => item.key !== upload.key));
    }
  }

  function start(files: FileList | File[]) {
    let room = roomLeft(sourceCount + uploads.length);
    const started: Upload[] = [];
    for (const file of Array.from(files)) {
      const problem = checkFile(file);
      if (problem) {
        addProblem(problem);
        continue;
      }
      if (room === 0) {
        addProblem(
          `"${file.name}" was not uploaded: a project can have at most ${MAX_SOURCES} files. Remove one first.`,
        );
        continue;
      }
      room -= 1;
      started.push({ key: nextKey++, file, progress: 0, controller: new AbortController() });
    }
    if (started.length === 0) return;
    setUploads((list) => [...list, ...started]);
    setAnnouncement(`Uploading ${started.map((upload) => upload.file.name).join(', ')}.`);
    for (const upload of started) {
      inFlight.current.add(upload.controller);
      void send(upload);
    }
  }

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) start(event.dataTransfer.files);
  };

  const full = roomLeft(sourceCount + uploads.length) === 0;

  return (
    <div className="space-y-3">
      <section
        aria-label="Upload files"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/50 px-6 py-10 text-center transition-colors',
          dragging && 'border-foreground/40 bg-muted',
        )}
      >
        <Upload aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">Drag files here</p>
        <p id="upload-rules" className="text-sm text-muted-foreground">
          CSV or Excel · up to {formatBytes(MAX_UPLOAD_BYTES)} and{' '}
          {MAX_UPLOAD_ROWS.toLocaleString('en-US')} rows per file
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1"
          disabled={full}
          aria-describedby="upload-rules"
          onClick={() => inputRef.current?.click()}
        >
          Browse files
        </Button>
        {full && (
          <p className="text-xs text-muted-foreground">
            This project has {MAX_SOURCES} files, the most allowed. Remove one to add another.
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose files to upload"
          onChange={(event) => {
            if (event.target.files) start(event.target.files);
            event.target.value = '';
          }}
        />
      </section>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {uploads.length > 0 && (
        <ul aria-label="Uploads in progress" className="space-y-2">
          {uploads.map((upload) => {
            const percent = Math.round(upload.progress * 100);
            return (
              <li key={upload.key} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-mono">{upload.file.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {percent < 100 ? `Uploading ${percent}%` : 'Checking the file…'}
                    </span>
                  </div>
                  <ProgressBar value={upload.progress} label={`Uploading ${upload.file.name}`} />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Cancel upload of ${upload.file.name}`}
                  onClick={() => {
                    upload.controller.abort();
                  }}
                >
                  Cancel
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {problems.length > 0 && (
        <ul aria-label="Upload problems" className="space-y-2">
          {problems.map((problem) => (
            <li
              key={problem.key}
              role="alert"
              className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm text-destructive"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span className="flex-1">{problem.message}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                aria-label="Dismiss"
                onClick={() => {
                  setProblems((list) => list.filter((item) => item.key !== problem.key));
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
