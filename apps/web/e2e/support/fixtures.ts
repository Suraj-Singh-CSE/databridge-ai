import { expect, test as base } from '@playwright/test';

export { expect };
export type { Locator, Page } from '@playwright/test';

/** Chrome reports a blocked script, style, image or request as a console error naming the CSP. */
const CSP_MESSAGE = /Content[- ]Security[- ]Policy/i;

/**
 * `test` for every spec: fails the test when the page breaks the Content-Security-Policy
 * (docs/adr/0027-same-origin-and-access.md). CI runs the suite against the api serving the web
 * app, so the real production headers apply.
 */
export const test = base.extend<{ cspGuard: undefined }>({
  cspGuard: [
    async ({ page }, provide) => {
      const violations: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' && CSP_MESSAGE.test(message.text())) {
          violations.push(message.text());
        }
      });
      // Also catch violations the console may not show (e.g. report-only or in a worker).
      await page.exposeFunction('__reportCspViolation', (text: string) => {
        violations.push(text);
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          const report = (window as unknown as { __reportCspViolation?: (t: string) => void })
            .__reportCspViolation;
          report?.(
            `CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`,
          );
        });
      });
      await provide(undefined);
      expect(violations, 'Content-Security-Policy violations on the page').toEqual([]);
    },
    { auto: true },
  ],
});
