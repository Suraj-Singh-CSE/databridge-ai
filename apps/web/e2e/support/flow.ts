import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

/** Shared steps of the full-stack specs: account, project, sources, mapping and matching. */

export const sample = (name: string) =>
  fileURLToPath(new URL(`../../../../eval/samples/${name}`, import.meta.url));
export const SOURCES = ['crm_customers.csv', 'support_contacts.csv'];
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

/** Every email address in the uploaded files: none may be announced or put in the title. */
export const RAW_EMAILS = SOURCES.flatMap(
  (name) => readFileSync(sample(name), 'utf8').match(EMAIL) ?? [],
);

/** Phone columns are mapped to `phone` (E.164) so duplicates can be found by phone too. */
const PHONE_COLUMNS = new Set(['ph', 'contact']);

export const JOB_TIMEOUT = 120_000;

/** For `test.afterEach`: print what the page showed (CI cannot always fetch the trace artifact). */
export async function dumpPageOnFailure({ page }: { page: Page }, testInfo: TestInfo) {
  if (testInfo.status !== testInfo.expectedStatus) {
    console.log(`Page text at failure:\n${await page.locator('main').innerText()}`);
  }
}

export async function snapshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `test-results/screenshots/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

/** Announcements (toasts, aria-live and status regions) and the page title. */
export async function announcedText(page: Page): Promise<string> {
  const regions = page.locator('[aria-live], [role="status"], [role="alert"]');
  const texts = await regions.allInnerTexts();
  return [await page.title(), ...texts].join('\n');
}

/** WCAG 2 A/AA violations inside `main`, one line each (an empty list passes). */
export async function axeViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  return violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`,
  );
}

/** A fresh account and project with both samples uploaded and profiled; returns the project path. */
export async function projectWithProfiledSources(page: Page, who: string): Promise<string> {
  await page.goto('/create-account');
  await page.getByLabel('Name').fill(`${who} Tester`);
  await page.getByLabel('Email').fill(`e2e-${who.toLowerCase()}-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const newProject = page.getByRole('dialog', { name: 'New project' });
  await newProject.getByLabel('Name').fill(`E2E ${who.toLowerCase()} ${Date.now()}`);
  await newProject.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Add your source files' })).toBeVisible();
  const projectPath = /\/projects\/[^/?#]+/.exec(page.url())?.[0];
  expect(projectPath).toBeDefined();

  await page.getByLabel('Choose files to upload').setInputFiles(SOURCES.map(sample));
  for (const name of SOURCES) {
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row.getByText('Profiled', { exact: true })).toBeVisible({ timeout: JOB_TIMEOUT });
  }
  return projectPath ?? '';
}

const columnRow = (page: Page, column: string) =>
  page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: `${column}, other possible fields` }) });

/** Runs mapping for one file and gives every column a decision. */
async function approveMapping(page: Page, filename: string): Promise<void> {
  await page
    .getByRole('group', { name: 'Choose a file' })
    .getByRole('button', { name: new RegExp(filename.replace('.', '\\.')) })
    .click();
  await expect(page.getByRole('heading', { name: 'No suggestions yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Run mapping', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Column mapping suggestions' })).toBeVisible({
    timeout: JOB_TIMEOUT,
  });

  const acceptHigh = page.getByRole('button', { name: 'Accept all High' });
  if (await acceptHigh.isEnabled()) {
    await acceptHigh.click();
    const confirm = page.getByRole('dialog', { name: /^Accept \d+ High-confidence/ });
    await confirm.getByRole('button', { name: /^Accept \d+$/ }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText(/^Accepted \d+ columns?\./)).toBeVisible();
  }

  const pendingRows = page.getByRole('row').filter({ hasText: 'Pending' });
  while ((await pendingRows.count()) > 0) {
    const column = (await pendingRows.first().locator('th').innerText()).trim();
    if (PHONE_COLUMNS.has(column)) {
      await page.getByRole('button', { name: `Change ${column}` }).click();
      const change = page.getByRole('dialog', { name: 'Change mapping' });
      await change.getByLabel('Map to').selectOption('field:phone');
      await change.getByLabel('Cleaning').selectOption('to_e164_in');
      await change.getByRole('button', { name: 'Save change' }).click();
      await expect(change).toBeHidden();
      await expect(columnRow(page, column).getByText('Changed', { exact: true })).toBeVisible();
    } else {
      await page.getByRole('button', { name: `Reject ${column}` }).click();
      await expect(columnRow(page, column).getByText('Rejected', { exact: true })).toBeVisible();
    }
  }
  await expect(page.getByText('Mapping approved')).toBeVisible();
}

/** Mapping (Mock LLM provider in CI): every column of both files gets a decision. */
export async function approveAllMappings(page: Page, projectPath: string): Promise<void> {
  await page.goto(`${projectPath}/mapping`);
  await expect(page.getByRole('heading', { name: 'Columns that match' })).toBeVisible();
  for (const name of SOURCES) await approveMapping(page, name);
}

/** A matching step's heading, e.g. "2. Find possible duplicates Done". */
const stepDone = (page: Page, title: string) =>
  page.getByRole('heading', { level: 3, name: new RegExp(`^\\d+\\. ${title} Done`) });

async function runStep(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: `Run: ${title}` }).click();
  await expect(stepDone(page, title)).toBeVisible({ timeout: JOB_TIMEOUT });
}

/** Prepare matching: the five steps, in order, ending with the customers grouped. */
export async function runMatchingSteps(page: Page, projectPath: string): Promise<void> {
  await page.goto(`${projectPath}/matching`);
  await expect(page.getByRole('heading', { name: 'Prepare matching' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No customers yet' })).toBeVisible();
  for (const name of SOURCES) {
    await page.getByRole('button', { name: `Clean: Clean ${name}` }).click();
  }
  await expect(stepDone(page, 'Clean data')).toBeVisible({ timeout: JOB_TIMEOUT });
  await runStep(page, 'Find possible duplicates');
  await runStep(page, 'Score pairs');
  const review = page.getByRole('button', { name: 'Run: AI review of unclear pairs' });
  if (await review.isEnabled()) {
    await runStep(page, 'AI review of unclear pairs');
  } else {
    await expect(page.getByText('No unclear pairs to review.')).toBeVisible();
  }
  await runStep(page, 'Group records');
}

/** "Approve all High" on Match review, after confirming (or the note that none are waiting). */
export async function approveAllHigh(page: Page): Promise<void> {
  const approveHigh = page.getByRole('button', { name: 'Approve all High' });
  if (await approveHigh.isEnabled()) {
    await approveHigh.click();
    const confirm = page.getByRole('dialog', { name: /^Approve \d+ High-confidence groups?\?$/ });
    await confirm.getByRole('button', { name: /^Approve \d+$/ }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText(/^Approved \d+ groups?\./)).toBeVisible();
  } else {
    await expect(
      page.getByText('No High-confidence groups are waiting for approval.'),
    ).toBeVisible();
  }
}

/** Drafts SQL from the approved customers, approves the new version and runs it. */
export async function approveAndRunSql(page: Page, projectPath: string): Promise<void> {
  await page.goto(`${projectPath}/pipeline`);
  await page.getByRole('button', { name: 'Draft SQL', exact: true }).click();
  const draft = page.getByRole('dialog', { name: 'Draft SQL' });
  await draft.getByRole('radio', { name: /^Approved customers/ }).check();
  await draft.getByRole('button', { name: 'Start draft' }).click();
  await expect(draft).toBeHidden();
  const drafted = page.getByText(/^Version \d+ is drafted\./);
  await expect(drafted).toBeVisible({ timeout: JOB_TIMEOUT });
  const version = /\d+/.exec(await drafted.innerText())?.[0] ?? '';

  const details = page.getByRole('region', { name: `Version ${version} details` });
  await details.getByRole('button', { name: `Approve version ${version}` }).click();
  const confirm = page.getByRole('dialog', { name: `Approve version ${version}?` });
  await confirm.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(confirm).toBeHidden();
  const current = page.getByRole('region', { name: `Current SQL · version ${version}` });
  await expect(current).toBeVisible({ timeout: 15_000 });
  await current.getByRole('button', { name: `Run SQL version ${version}` }).click();
  await expect(current.getByText(/rows · passed$/)).toBeVisible({ timeout: JOB_TIMEOUT });
}

/** Runs the quality checks once; returns the latest report's overall status, e.g. "Warning". */
export async function runQualityChecks(page: Page, projectPath: string): Promise<string> {
  await page.goto(`${projectPath}/quality`);
  await page.getByRole('button', { name: 'Run quality checks', exact: true }).click();
  const overall = page
    .getByRole('region', { name: 'Latest report' })
    .getByText(/^Overall: (Pass|Warning|Fail|Skipped)$/);
  await expect(overall).toBeVisible({ timeout: JOB_TIMEOUT });
  return (await overall.innerText()).replace('Overall: ', '');
}
