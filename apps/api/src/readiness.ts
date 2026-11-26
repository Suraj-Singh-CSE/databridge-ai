/** name -> async check that throws (or hangs) when the dependency is not usable. */
export type ReadinessChecks = Record<string, () => Promise<unknown>>;

export const READINESS_TIMEOUT_MS = 2000;

/**
 * Runs every check at once, each bounded by `timeoutMs`. Results are only "ok" or
 * "unavailable": error details (hosts, credentials in URLs) never leave the process.
 */
export async function runReadiness(
  checks: ReadinessChecks,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<Record<string, 'ok' | 'unavailable'>> {
  const run = async (check: () => Promise<unknown>): Promise<'ok' | 'unavailable'> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('readiness check timed out'));
      }, timeoutMs);
    });
    try {
      await Promise.race([check(), timeout]);
      return 'ok';
    } catch {
      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  };
  const entries = Object.entries(checks);
  const results = await Promise.all(entries.map(([, check]) => run(check)));
  return Object.fromEntries(entries.map(([name], i) => [name, results[i] ?? 'unavailable']));
}
