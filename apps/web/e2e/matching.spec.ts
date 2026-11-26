import { expect, test, type Locator, type Page } from './support/fixtures';

import {
  announcedText,
  approveAllHigh,
  approveAllMappings,
  axeViolations,
  dumpPageOnFailure,
  JOB_TIMEOUT,
  projectWithProfiledSources,
  RAW_EMAILS,
  runMatchingSteps,
  snapshot,
} from './support/flow';

test.afterEach(dumpPageOnFailure);

async function cardValue(page: Page, label: string): Promise<number> {
  const value = page
    .getByText(label, { exact: true })
    .locator('xpath=following-sibling::p[1]')
    .first();
  return Number((await value.innerText()).replace(/\D/g, ''));
}

const detailOf = (page: Page, customerId: string): Locator =>
  page.getByRole('region', { name: new RegExp(`^Customer ${customerId}`) });

test('clean, match and group two files, then review a customer', async ({ page }) => {
  test.setTimeout(480_000);
  expect(RAW_EMAILS.length).toBeGreaterThan(0);

  // A fresh account and project with both samples profiled, mapped and grouped.
  const projectPath = await projectWithProfiledSources(page, 'Matching');
  await approveAllMappings(page, projectPath);
  await runMatchingSteps(page, projectPath);

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
  await approveAllHigh(page);

  // No raw email is announced or put in the page title (records themselves may show them).
  const announced = await announcedText(page);
  for (const value of RAW_EMAILS) expect(announced).not.toContain(value);

  // Automated accessibility check with a customer's details open.
  const nextId = (await customers.getByRole('row').nth(1).locator('th').innerText()).trim();
  await customers.getByRole('button', { name: `Details for ${nextId}` }).click();
  await expect(detailOf(page, nextId)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
