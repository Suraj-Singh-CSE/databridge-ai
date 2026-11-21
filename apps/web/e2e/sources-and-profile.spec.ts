import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

const sample = (name: string) =>
  fileURLToPath(new URL(`../../../eval/samples/${name}`, import.meta.url));

/** Raw values from the first row of crm_customers.csv: none may appear on the Profile screen. */
const RAW_CRM_VALUES = ['rudra_s860@example.net', 'Rudra Shroff', '6376476497', '14/12/1975'];

async function snapshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `test-results/screenshots/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

test('upload CSV and XLSX, watch them profile, then read the masked column profile', async ({
  page,
}) => {
  test.setTimeout(120_000);

  // A fresh account and project.
  await page.goto('/create-account');
  await page.getByLabel('Name').fill('Profile Tester');
  await page.getByLabel('Email').fill(`e2e-profile-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill(`E2E profile ${Date.now()}`);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Add your source files' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No files yet' })).toBeVisible();

  // Upload both samples; each is profiled automatically after its upload.
  await page
    .getByLabel('Choose files to upload')
    .setInputFiles([sample('crm_customers.csv'), sample('billing_export.xlsx')]);

  const crmRow = page.getByRole('row').filter({ hasText: 'crm_customers.csv' });
  const billingRow = page.getByRole('row').filter({ hasText: 'billing_export.xlsx' });
  await expect(crmRow.getByText('Profiled', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(billingRow.getByText('Profiled', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(crmRow).toContainText('143 × 10');
  await expect(billingRow).toContainText('151 × 9');
  await snapshot(page, '05-sources');

  // Preview shows the file as uploaded (members only).
  await crmRow.getByRole('button', { name: 'Preview crm_customers.csv' }).click();
  const preview = page.getByRole('dialog', { name: 'Preview · crm_customers.csv' });
  await expect(preview.getByRole('columnheader', { name: 'email_id' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();

  // Profile: column rows, masked samples, never a raw value.
  await page.getByRole('link', { name: 'Continue to profiling' }).click();
  await expect(page.getByRole('heading', { name: "What's in your data" })).toBeVisible();
  const picker = page.getByRole('group', { name: 'Choose a file' });
  await picker.getByRole('button', { name: /crm_customers\.csv/ }).click();
  await expect(page.getByRole('rowheader', { name: 'cust_id, details' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'ph, details' })).toBeVisible();

  await page.getByRole('button', { name: 'email_id, details' }).click();
  const samples = page.getByRole('list', { name: 'Masked samples of email_id' });
  await expect(samples).toContainText('[EMAIL]');
  await page.getByRole('button', { name: 'cust_nm, details' }).click();
  await snapshot(page, '06-profile');

  const text = await page.locator('main').innerText();
  for (const value of RAW_CRM_VALUES) expect(text).not.toContain(value);

  // The Excel file has its own profile.
  await picker.getByRole('button', { name: /billing_export\.xlsx/ }).click();
  await expect(page.getByRole('rowheader', { name: 'PAN, details' })).toBeVisible();
});
