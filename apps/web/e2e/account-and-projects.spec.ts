import { expect, test, type Page } from '@playwright/test';

/** Full-page screenshots for comparing with the Figma screens (uploaded by CI). */
async function snapshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `test-results/screenshots/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

test('create account, create a project, sign out and sign in again', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = 'e2e-password-123';
  const projectName = `E2E project ${Date.now()}`;

  // Create account -> lands on Projects.
  await page.goto('/create-account');
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await snapshot(page, '00-create-account');
  await page.getByLabel('Name').fill('E2E Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

  // Create a project -> its Sources step.
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill(projectName);
  await dialog.getByLabel('Description').fill('Created by the e2e test');
  await snapshot(page, '03-new-project-dialog');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[a-f\d]{24}\/sources$/);
  await expect(page.getByRole('heading', { name: 'Add your source files' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(projectName);
  await snapshot(page, '04-project-sources');

  // Back to the list: the new project is there.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(page.getByText('Step 1 of 6 · Sources')).toBeVisible();
  await snapshot(page, '02-projects');

  // Sign out from the user menu.
  await page.getByRole('button', { name: 'Account menu for E2E Tester' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);

  // Reloading must not restore the session (the refresh cookie was revoked).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await snapshot(page, '01-sign-in');

  // Wrong password shows the calm message.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Email or password is incorrect.');

  // Sign in again -> the project is still listed.
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

  // A reload restores the session from the refresh cookie (no sign-in page).
  await page.reload();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
});

test('two tabs refreshing at the same moment stay signed in, and sign-out reaches both', async ({
  context,
}) => {
  const tabA = await context.newPage();
  await tabA.goto('/create-account');
  await tabA.getByLabel('Name').fill('Two Tabs');
  await tabA.getByLabel('Email').fill(`e2e-tabs-${Date.now()}@example.com`);
  await tabA.getByLabel('Password').fill('e2e-password-123');
  await tabA.getByRole('button', { name: 'Create account' }).click();
  await expect(tabA.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

  const tabB = await context.newPage();
  await tabB.goto('/projects');
  await expect(tabB.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

  // Both tabs restore their session from the same refresh cookie at once. Without the Web Lock
  // the api would see the same refresh token twice, treat it as theft and revoke the session.
  // Holding each refresh for a moment widens the race window so the test cannot pass by luck.
  await context.route('**/api/v1/auth/refresh', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await Promise.all([tabA.reload(), tabB.reload()]);
  await expect(tabA.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(tabB.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

  // The session family is still alive: another reload restores it again.
  await context.unrouteAll();
  await tabA.reload();
  await expect(tabA.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

  // Signing out in one tab signs out the other.
  await tabA.getByRole('button', { name: 'Account menu for Two Tabs' }).click();
  await tabA.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(tabA.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(tabB.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
