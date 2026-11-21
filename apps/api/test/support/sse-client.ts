import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';

export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** A running HTTP server for tests that need a real streaming connection. */
export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Reads an SSE response the way the web client will: fetch() with a Bearer header, streaming.
 * `next()` resolves with the next frame (or null when the server ended the stream).
 */
export class SseClient {
  readonly comments: string[] = [];
  private buffer = '';
  private ended = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly controller: AbortController;

  private constructor(
    readonly response: Response,
    controller: AbortController,
  ) {
    if (!response.body) throw new Error('no body');
    this.reader = response.body.getReader();
    this.controller = controller;
  }

  static async open(url: string, token: string): Promise<SseClient> {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return new SseClient(response, controller);
  }

  async next(timeoutMs = 3000): Promise<SseFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.takeFrame();
      if (frame) return frame;
      if (this.ended) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('no SSE frame in time');
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('no SSE frame in time'));
          }, remaining),
        ),
      ]);
      if (chunk.done) this.ended = true;
      else this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** Reads frames until the server ends the stream. */
  async rest(timeoutMs = 3000): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    for (let frame = await this.next(timeoutMs); frame; frame = await this.next(timeoutMs)) {
      frames.push(frame);
    }
    return frames;
  }

  close(): void {
    this.controller.abort();
  }

  private takeFrame(): SseFrame | null {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end === -1) return null;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (block.startsWith(':')) {
        this.comments.push(block.slice(1).trim());
        continue;
      }
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        if (line.startsWith('data: ')) data += line.slice(6);
      }
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    }
  }
}
