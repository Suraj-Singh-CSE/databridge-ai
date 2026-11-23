import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

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

/** A completeness rule's new warn value, below its default so `fail = 100` is on the wrong side. */
const NEW_WARN: Record<string, { warn: string; shown: string }> = {
  'Required field filled in': { warn: '99.5', shown: 'Warn below 99.5%' },
  'Optional field filled in': { warn: '75', shown: 'Warn below 75%' },
};

const digits = (text: string) => Number(text.replace(/\D/g, ''));

async function expectNothingAnnounced(page: Page): Promise<void> {
  const announced = await announcedText(page);
  for (const value of RAW_EMAILS) expect(announced).not.toContain(value);
}

/** Starts an export from the "New export" dialog with the given choices. */
async function startExport(
  page: Page,
  choices: { format: RegExp; scope: RegExp; includeSources: boolean },
): Promise<void> {
  await page.getByRole('button', { name: 'New export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New export' });
  await dialog.getByRole('radio', { name: choices.format }).check();
  await dialog.getByRole('radio', { name: choices.scope }).check();
  await dialog
    .getByRole('checkbox', { name: /^Include source record keys/ })
    .setChecked(choices.includeSources);
  await dialog.getByRole('button', { name: 'Start export' }).click();
  await expect(dialog).toBeHidden();
}

/** Clicks a row's Download button and returns the file Playwright saw and its bytes. */
async function download(page: Page, row: Locator, name: RegExp) {
  const downloaded = page.waitForEvent('download');
  await row.getByRole('button', { name }).click();
  const file = await downloaded;
  const path = await file.path();
  return { filename: file.suggestedFilename(), bytes: readFileSync(path) };
}

test('draft, approve and run the SQL, export the customers, then check quality', async ({
  page,
}) => {
  test.setTimeout(600_000);
  expect(RAW_EMAILS.length).toBeGreaterThan(0);

  // Setup: both samples profiled, mapped and grouped, and the High-confidence groups approved.
  const projectPath = await projectWithProfiledSources(page, 'Pipeline');
  await approveAllMappings(page, projectPath);
  await runMatchingSteps(page, projectPath);
  await expect(page.getByRole('heading', { name: 'Customers found' })).toBeVisible();
  await approveAllHigh(page);

  // ---- Pipeline
  await page.goto(`${projectPath}/pipeline`);
  await expect(page.getByRole('heading', { name: 'No SQL version yet' })).toBeVisible();
  const draftButton = page.getByRole('button', { name: 'Draft SQL', exact: true });
  const draftDialog = page.getByRole('dialog', { name: 'Draft SQL' });

  // Keyboard only: Enter opens the Draft SQL dialog, Escape closes it, focus returns.
  await draftButton.focus();
  await page.keyboard.press('Enter');
  await expect(draftDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(draftDialog).toBeHidden();
  await expect(draftButton).toBeFocused();

  // Draft SQL from the approved customers, with an instruction.
  await draftButton.click();
  await draftDialog.getByRole('radio', { name: /^Approved customers/ }).check();
  await draftDialog
    .getByLabel('Instructions (optional)')
    .fill('Prefer CRM values when sources disagree');
  await draftDialog.getByRole('button', { name: 'Start draft' }).click();
  await expect(draftDialog).toBeHidden();
  const drafted = page.getByText(/^Version \d+ is drafted\./);
  await expect(drafted).toBeVisible({ timeout: JOB_TIMEOUT });
  const version = digits((await drafted.innerText()).split(' is ')[0] ?? '');
  expect(version).toBeGreaterThanOrEqual(1);

  // The new version opens itself: every test on the sample passed.
  const details = page.getByRole('region', { name: `Version ${version} details` });
  const summary = details.getByText(/^\d+ of \d+ tests passed/);
  await expect(summary).toBeVisible();
  const [passed, total] = ((await summary.innerText()).match(/\d+/g) ?? []).map(Number);
  expect(total).toBeGreaterThan(0);
  expect(passed).toBe(total);
  await expect(details.getByText('Failed', { exact: true })).toHaveCount(0);
  const versions = page.getByRole('table', { name: 'SQL versions' });
  const versionRow = versions.getByRole('row').filter({ hasText: `v${version}` });
  await expect(versionRow).toContainText('Draft');
  await expect(versionRow).toContainText(`${total}/${total} passed`);

  // Approve, after confirming: it becomes the current SQL.
  const approve = details.getByRole('button', { name: `Approve version ${version}` });
  await expect(approve).toBeEnabled();
  await expect(details.getByText('All tests must pass before approval.')).toHaveCount(0);
  await approve.click();
  const confirm = page.getByRole('dialog', { name: `Approve version ${version}?` });
  await confirm.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(
    page.getByText(`Version ${version} approved. It is now the current SQL.`),
  ).toBeVisible();
  // The status pill and the "Approved" fact (when and by whom).
  await expect(details.getByText('Approved', { exact: true })).toHaveCount(2);
  await expect(versionRow).toContainText('Approved');
  const current = page.getByRole('region', { name: `Current SQL · version ${version}` });
  await expect(current.getByText('Approved', { exact: true })).toHaveCount(2);

  // Run the current SQL: the last run passed.
  await current.getByRole('button', { name: `Run SQL version ${version}` }).click();
  await expect(page.getByText(/^The SQL ran.* and every check passed\.$/)).toBeVisible({
    timeout: JOB_TIMEOUT,
  });
  await expect(current.getByText(/rows · passed$/)).toBeVisible({ timeout: 30_000 });

  // CSV export of the approved customers: the file matches the list.
  const exportsTable = page.getByRole('table', { name: 'Exports' });
  await startExport(page, { format: /^CSV/, scope: /^Approved only/, includeSources: false });
  await expect(page.getByText(/^Export ready/)).toBeVisible({ timeout: JOB_TIMEOUT });
  const csvRow = exportsTable.getByRole('row').filter({ hasText: /^csv/i });
  await expect(csvRow).toHaveCount(1);
  const listedRows = digits(await csvRow.getByRole('cell').nth(1).innerText());
  const csv = await download(page, csvRow, /^Download customers-.+\.csv$/);
  expect(csv.filename).toMatch(/^customers-.+\.csv$/);
  expect(csv.bytes.length).toBeGreaterThan(0);
  const lines = csv.bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line !== '');
  expect(lines[0]).toMatch(/^"?customer_id"?(,|$)/);
  expect(lines.length - 1).toBe(listedRows);
  await expect(page.getByText(`Downloaded ${csv.filename}.`)).toBeVisible();

  // Excel export of every customer with source keys: an .xlsx file is a ZIP archive.
  await startExport(page, {
    format: /^Excel/,
    scope: /^All with review status/,
    includeSources: true,
  });
  const xlsxRow = exportsTable.getByRole('row').filter({ hasText: /^xlsx/i });
  await expect(xlsxRow).toHaveCount(1, { timeout: JOB_TIMEOUT });
  const xlsx = await download(page, xlsxRow, /^Download customers-.+\.xlsx$/);
  expect(xlsx.filename).toMatch(/^customers-.+\.xlsx$/);
  expect(xlsx.bytes.subarray(0, 2).toString('latin1')).toBe('PK');

  // With a version open: nothing personal announced, and no accessibility violations.
  await expect(details).toBeVisible();
  await expectNothingAnnounced(page);
  await snapshot(page, '09-pipeline');
  expect(await axeViolations(page)).toEqual([]);

  // ---- Data quality
  await page.goto(`${projectPath}/quality`);
  await expect(page.getByRole('heading', { name: 'No quality report yet' })).toBeVisible();
  const runChecks = page.getByRole('button', { name: 'Run quality checks', exact: true });
  const finished = page.getByText(/^The quality check finished/);
  await runChecks.click();
  await expect(finished).toBeVisible({ timeout: JOB_TIMEOUT });

  // The latest report: an overall status and the rules grouped by kind.
  const report = page.getByRole('region', { name: 'Latest report' });
  await expect(report.getByText(/^Overall: (Pass|Warning|Fail|Skipped)$/)).toBeVisible();
  await expect(report.getByRole('heading', { level: 3, name: 'Completeness' })).toBeVisible();
  expect(await report.getByRole('heading', { level: 3 }).count()).toBeGreaterThanOrEqual(2);
  const completeness = report.getByRole('table', { name: 'Completeness rules' });
  const ruleName = (
    await completeness.getByRole('row').nth(1).locator('th span').first().innerText()
  ).trim();
  const change = NEW_WARN[ruleName];
  if (!change) throw new Error(`Unexpected completeness rule "${ruleName}"`);
  const ruleRows = completeness.getByRole('row').filter({ hasText: ruleName });
  await expect(ruleRows.first()).not.toContainText(change.shown);

  // Edit thresholds: fail on the wrong side of warn is refused, then the new warn is saved.
  await page.getByRole('button', { name: 'Edit thresholds', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit thresholds' });
  const rule = edit.getByRole('group', { name: ruleName, exact: true });
  await rule.getByLabel('Warn below (%)').fill(change.warn);
  await rule.getByLabel('Fail below (%)').fill('100');
  await edit.getByRole('button', { name: 'Save thresholds' }).click();
  await expect(
    rule.getByText('Fail must be at or below warn: this value should stay high.'),
  ).toBeVisible();
  await expect(rule.getByLabel('Fail below (%)')).toHaveAttribute('aria-invalid', 'true');
  await expect(
    edit.getByText('Some values need fixing. Check the messages under the fields.'),
  ).toBeVisible();
  await expect(edit).toBeVisible();
  await rule.getByLabel('Fail below (%)').fill('');
  await edit.getByRole('button', { name: 'Save thresholds' }).click();
  await expect(edit).toBeHidden();
  await expect(
    page.getByText('Thresholds saved. They apply from the next quality check.'),
  ).toBeVisible();

  // The next run uses the new threshold.
  await runChecks.click();
  await expect(ruleRows.first()).toContainText(change.shown, { timeout: JOB_TIMEOUT });
  await expect(finished).toBeVisible({ timeout: JOB_TIMEOUT });
  for (const row of await ruleRows.all()) await expect(row).toContainText(change.shown);

  // With the report shown: nothing personal announced, and no accessibility violations.
  await expectNothingAnnounced(page);
  await snapshot(page, '10-quality');
  expect(await axeViolations(page)).toEqual([]);
});
