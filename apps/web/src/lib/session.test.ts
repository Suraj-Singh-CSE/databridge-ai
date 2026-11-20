import { afterEach, describe, expect, it } from 'vitest';

import type { AuthMessage } from '@/lib/session';
import {
  clearSession,
  getAccessToken,
  getAuthState,
  receiveAuthMessage,
  setSession,
  startAuthSync,
} from '@/lib/session';
import { makeSession } from '@/test/fixtures';

describe('session sync between tabs', () => {
  let stop: () => void = () => undefined;
  let otherTab: BroadcastChannel | null = null;

  afterEach(() => {
    stop();
    otherTab?.close();
  });

  function listenAsOtherTab(): Promise<AuthMessage> {
    otherTab = new BroadcastChannel('databridge-auth');
    return new Promise((resolve) => {
      otherTab?.addEventListener('message', (event: MessageEvent<AuthMessage>) => {
        resolve(event.data);
      });
    });
  }

  it('broadcasts an explicit sign-out to other tabs', async () => {
    stop = startAuthSync();
    const received = listenAsOtherTab();

    clearSession({ broadcast: true });

    await expect(received).resolves.toMatchObject({ type: 'signed-out' });
  });

  it('shares a new session with other tabs', async () => {
    stop = startAuthSync();
    const received = listenAsOtherTab();

    setSession(makeSession('admin', 'new-token'), { broadcast: true });

    await expect(received).resolves.toMatchObject({
      type: 'session',
      session: { accessToken: 'new-token' },
    });
  });

  it('signs this tab out when another tab signs out', () => {
    setSession(makeSession(), { broadcast: false });

    receiveAuthMessage({ type: 'signed-out', at: Date.now() });

    expect(getAuthState()).toEqual({ status: 'signed-out' });
    expect(getAccessToken()).toBeNull();
  });
});
