import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CRM_SAMPLE = fileURLToPath(
  new URL('../../../eval/samples/crm_customers.csv', import.meta.url),
);

/** Every email address in the sample file: none may appear on the Mapping screen. */
const RAW_EMAILS = readFileSync(CRM_SAMPLE, 'utf8').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];

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

test('run mapping, accept the High suggestions, change one and approve the file', async ({
  page,
}) => {
  test.setTimeout(150_000);
  expect(RAW_EMAILS.length).toBeGreaterThan(0);

  // A fresh account and project with the CRM sample profiled.
  await page.goto('/create-account');
  await page.getByLabel('Name').fill('Mapping Tester');
  await page.getByLabel('Email').fill(`e2e-mapping-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const newProject = page.getByRole('dialog', { name: 'New project' });
  await newProject.getByLabel('Name').fill(`E2E mapping ${Date.now()}`);
  await newProject.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Add your source files' })).toBeVisible();

  await page.getByLabel('Choose files to upload').setInputFiles(CRM_SAMPLE);
  const crmRow = page.getByRole('row').filter({ hasText: 'crm_customers.csv' });
  await expect(crmRow.getByText('Profiled', { exact: true })).toBeVisible({ timeout: 60_000 });

  // Mapping: run it (Mock LLM provider in CI) and wait for the suggestions.
  await page.getByRole('link', { name: 'Continue to profiling' }).click();
  await page.getByRole('link', { name: 'Continue to mapping' }).click();
  await expect(page.getByRole('heading', { name: 'Columns that match' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No suggestions yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Run mapping' }).click();
  await expect(page.getByRole('table', { name: 'Column mapping suggestions' })).toBeVisible({
    timeout: 60_000,
  });

  const email = columnRow(page, 'email_id');
  await expect(email.getByRole('cell').nth(0).locator('.font-mono')).toHaveText('email');
  await expect(email.getByText(/^High · \d+%$/)).toBeVisible();
  await expect(email.getByText('Pending', { exact: true })).toBeVisible();

  // Accept all High, after confirming.
  const highRows = page.getByRole('row').filter({ hasText: /High · \d+%/ });
  const highCount = await highRows.count();
  expect(highCount).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Accept all High' }).click();
  const confirm = page.getByRole('dialog', { name: /^Accept \d+ High-confidence suggestions?\?$/ });
  await confirm.getByRole('button', { name: `Accept ${highCount}` }).click();
  await expect(confirm).toBeHidden();
  const plural = highCount === 1 ? 'column' : 'columns';
  await expect(page.getByText(`Accepted ${highCount} ${plural}.`)).toBeVisible();
  for (const row of await highRows.all()) {
    await expect(row.getByText('Accepted', { exact: true })).toBeVisible();
  }

  // Keyboard only: Tab reaches Change, Enter opens the dialog, Escape closes it and
  // focus returns to the same Change button.
  // Uses a column still pending, or the last column if High covered them all.
  const pendingRows = page.getByRole('row').filter({ hasText: 'Pending' });
  const firstPending =
    (await pendingRows.count()) > 0 ? pendingRows.first() : page.getByRole('row').last();
  const pendingColumn = (await firstPending.locator('th').innerText()).trim();
  const changeButton = page.getByRole('button', { name: `Change ${pendingColumn}` });
  await page.getByRole('button', { name: `Reject ${pendingColumn}` }).focus();
  await page.keyboard.press('Tab');
  await expect(changeButton).toBeFocused();
  await page.keyboard.press('Enter');
  const change = page.getByRole('dialog', { name: 'Change mapping' });
  await expect(change).toBeVisible();
  await expect(change).toContainText(pendingColumn);
  await page.keyboard.press('Escape');
  await expect(change).toBeHidden();
  await expect(changeButton).toBeFocused();

  // Change that column to "Not mapped".
  await changeButton.click();
  await change.getByLabel('Map to').selectOption({ label: 'Not mapped' });
  await change.getByRole('button', { name: 'Save change' }).click();
  await expect(change).toBeHidden();
  await expect(page.getByText(`Changed ${pendingColumn} to Not mapped.`)).toBeVisible();
  await expect(columnRow(page, pendingColumn).getByText('Changed', { exact: true })).toBeVisible();

  // Reject whatever is still pending; then every column has a decision.
  while ((await pendingRows.count()) > 0) {
    const column = (await pendingRows.first().locator('th').innerText()).trim();
    await page.getByRole('button', { name: `Reject ${column}` }).click();
    await expect(columnRow(page, column).getByText('Rejected', { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Mapping approved')).toBeVisible();
  await expect(page.getByText(/^\d+ decided · 0 pending/)).toBeVisible();
  await snapshot(page, '07-mapping-review');

  // No raw value from the file reaches the screen.
  const text = await page.locator('main').innerText();
  for (const value of RAW_EMAILS) expect(text).not.toContain(value);

  // Automated accessibility check of the Mapping screen.
  const { violations } = await new AxeBuilder({ page })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const summary = violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`);
  expect(summary).toEqual([]);
});
