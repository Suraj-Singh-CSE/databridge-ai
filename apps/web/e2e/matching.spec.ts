import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const sample = (name: string) =>
  fileURLToPath(new URL(`../../../eval/samples/${name}`, import.meta.url));
const SOURCES = ['crm_customers.csv', 'support_contacts.csv'];
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

/** Every email address in the uploaded files: none may be announced or put in the title. */
const RAW_EMAILS = SOURCES.flatMap((name) => readFileSync(sample(name), 'utf8').match(EMAIL) ?? []);

/** Phone columns are mapped to `phone` (E.164) so duplicates can be found by phone too. */
const PHONE_COLUMNS = new Set(['ph', 'contact']);

const JOB_TIMEOUT = 120_000;

// On failure, print what the page showed (CI cannot always fetch the trace artifact).
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    console.log(`Page text at failure:\n${await page.locator('main').innerText()}`);
  }
});

async function snapshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `test-results/screenshots/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
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

/** A matching step's heading, e.g. "2. Find possible duplicates Done". */
const stepDone = (page: Page, title: string) =>
  page.getByRole('heading', { level: 3, name: new RegExp(`^\\d+\\. ${title} Done`) });

async function runStep(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: `Run: ${title}` }).click();
  await expect(stepDone(page, title)).toBeVisible({ timeout: JOB_TIMEOUT });
}

async function cardValue(page: Page, label: string): Promise<number> {
  const value = page
    .getByText(label, { exact: true })
    .locator('xpath=following-sibling::p[1]')
    .first();
  return Number((await value.innerText()).replace(/\D/g, ''));
}

/** Announcements (toasts, aria-live and status regions) and the page title. */
async function announcedText(page: Page): Promise<string> {
  const regions = page.locator('[aria-live], [role="status"], [role="alert"]');
  const texts = await regions.allInnerTexts();
  return [await page.title(), ...texts].join('\n');
}

const detailOf = (page: Page, customerId: string): Locator =>
  page.getByRole('region', { name: new RegExp(`^Customer ${customerId}`) });

test('clean, match and group two files, then review a customer', async ({ page }) => {
  test.setTimeout(480_000);
  expect(RAW_EMAILS.length).toBeGreaterThan(0);

  // A fresh account and project with both samples profiled.
  await page.goto('/create-account');
  await page.getByLabel('Name').fill('Matching Tester');
  await page.getByLabel('Email').fill(`e2e-matching-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const newProject = page.getByRole('dialog', { name: 'New project' });
  await newProject.getByLabel('Name').fill(`E2E matching ${Date.now()}`);
  await newProject.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Add your source files' })).toBeVisible();
  const projectPath = /\/projects\/[^/?#]+/.exec(page.url())?.[0];
  expect(projectPath).toBeDefined();

  await page.getByLabel('Choose files to upload').setInputFiles(SOURCES.map(sample));
  for (const name of SOURCES) {
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row.getByText('Profiled', { exact: true })).toBeVisible({ timeout: JOB_TIMEOUT });
  }

  // Mapping (Mock LLM provider in CI): every column of both files gets a decision.
  await page.goto(`${projectPath}/mapping`);
  await expect(page.getByRole('heading', { name: 'Columns that match' })).toBeVisible();
  for (const name of SOURCES) await approveMapping(page, name);

  // Prepare matching: the five steps, in order.
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

  // Customers found: people found and at least one group of 2 or more records.
  await expect(page.getByRole('heading', { name: 'Customers found' })).toBeVisible();
  expect(await cardValue(page, 'People found')).toBeGreaterThanOrEqual(1);
  expect(await cardValue(page, 'Records merged')).toBeGreaterThanOrEqual(1);

  // Open the first multi-record customer: records side by side, golden value with provenance.
  const customers = page.getByRole('table', { name: 'Customers found' });
  const firstRow = customers.getByRole('row').nth(1);
  const customerId = (await firstRow.locator('th').innerText()).trim();
  const size = Number(await firstRow.getByRole('cell').first().innerText());
  expect(size).toBeGreaterThanOrEqual(2);
  await customers.getByRole('button', { name: `Details for ${customerId}` }).click();
  const detail = detailOf(page, customerId);
  const records = detail.getByRole('table', { name: `Records of customer ${customerId}` });
  await expect(records.getByRole('columnheader', { name: 'Field' })).toBeVisible();
  await expect(records.getByRole('columnheader', { name: 'Golden record' })).toBeVisible();
  await expect(records.getByRole('columnheader')).toHaveCount(size + 2);
  await expect(records.getByText(/^From .+ row \d+/).first()).toBeVisible();

  // Approve the group.
  await detail.getByRole('button', { name: 'Approve group' }).click();
  await expect(page.getByText(`Approved customer ${customerId}.`)).toBeVisible();
  await expect(detail.getByText('Approved', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Undo approval' })).toBeVisible();
  await snapshot(page, '08-match-review');

  // Keyboard only: Enter opens the Split dialog, Escape closes it, focus returns to the trigger.
  const splitButton = detail.getByRole('button', { name: /^Split out / }).last();
  await splitButton.focus();
  await page.keyboard.press('Enter');
  const split = page.getByRole('dialog', { name: 'Split this record out?' });
  await expect(split).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(split).toBeHidden();
  await expect(splitButton).toBeFocused();

  // Split the last record out (with a reason); the groups are rebuilt.
  await splitButton.click();
  await split.getByLabel('Reason (optional)').fill('Different person in the e2e test');
  await split.getByRole('button', { name: 'Split out', exact: true }).click();
  await expect(split).toBeHidden();
  const rebuild = page.getByRole('progressbar', { name: 'Rebuilding the groups' });
  await rebuild.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  await expect(rebuild).toBeHidden({ timeout: JOB_TIMEOUT });

  // The original customer lost a record: it is gone, or it has fewer records.
  const searchBox = page.getByLabel('Search by customer id');
  await expect(async () => {
    await page.reload();
    await searchBox.fill(customerId);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const gone = page.getByRole('heading', { name: `No customer ${customerId}` });
    const row = customers.getByRole('row').filter({ hasText: customerId });
    await expect(gone.or(row)).toBeVisible();
    if (await gone.isVisible()) return;
    expect(Number(await row.getByRole('cell').first().innerText())).toBeLessThan(size);
  }).toPass({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Clear search' }).click();

  // Approve all High, after confirming.
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

  // No raw email is announced or put in the page title (records themselves may show them).
  const announced = await announcedText(page);
  for (const value of RAW_EMAILS) expect(announced).not.toContain(value);

  // Automated accessibility check with a customer's details open.
  const nextId = (await customers.getByRole('row').nth(1).locator('th').innerText()).trim();
  await customers.getByRole('button', { name: `Details for ${nextId}` }).click();
  await expect(detailOf(page, nextId)).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const summary = violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`);
  expect(summary).toEqual([]);
});
