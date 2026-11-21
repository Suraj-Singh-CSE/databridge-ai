import { vi } from 'vitest';

/**
 * A controllable XMLHttpRequest for upload tests: jsdom + MSW send the body in one go, so
 * intermediate upload progress can only be tested by driving the events by hand.
 */
export class FakeXhr extends EventTarget {
  static instances: FakeXhr[] = [];

  readonly upload = new EventTarget();
  readonly headers = new Map<string, string>();
  method = '';
  url = '';
  body: unknown = null;
  status = 0;
  response: unknown = null;
  responseType = '';
  withCredentials = false;
  aborted = false;

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: unknown): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
  }

  /** Test control: report `loaded` of `total` bytes sent. */
  progress(loaded: number, total: number): void {
    this.upload.dispatchEvent(
      Object.assign(new Event('progress'), { lengthComputable: true, loaded, total }),
    );
  }

  /** Test control: finish with `status` and a JSON `body`. */
  respond(status: number, body: unknown): void {
    this.status = status;
    this.response = body;
    this.dispatchEvent(new Event('load'));
  }

  /** Test control: a network failure. */
  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

/** Replaces window.XMLHttpRequest for the current test; returns the list of created requests. */
export function installFakeXhr(): FakeXhr[] {
  FakeXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return FakeXhr.instances;
}
