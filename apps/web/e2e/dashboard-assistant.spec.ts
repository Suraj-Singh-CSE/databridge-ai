import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  announcedText,
  approveAllHigh,
  approveAllMappings,
  approveAndRunSql,
  axeViolations,
  dumpPageOnFailure,
  JOB_TIMEOUT,
  projectWithProfiledSources,
  RAW_EMAILS,
  runMatchingSteps,
  runQualityChecks,
  snapshot,
} from './support/flow';

test.afterEach(dumpPageOnFailure);

/** The page heading each next-step link lands on, by the link's step label. */
const STEP_TITLES: Record<string, string> = {
  Sources: 'Add your source files',
  Profile: "What's in your data",
  Mapping: 'Columns that match',
  Matching: 'Is this the same person?',
  Pipeline: 'Build the clean dataset',
  'Data quality': 'Data quality report',
};

const digits = (text: string) => Number(text.replace(/\D/g, ''));

/** A Matching summary card's number ("People found", "Approved"). */
async function matchingCard(page: Page, label: string): Promise<number> {
  const value = page
    .getByRole('region', { name: 'Customers found' })
    .locator(`xpath=.//div[p[1][normalize-space(.)="${label}"]]/p[2]`);
  return digits(await value.innerText());
}

/** A dashboard pipeline card's value (the label may be followed by an "Out of date" pill). */
const dashboardStat = (page: Page, label: string): Locator =>
  page
    .getByRole('region', { name: 'Pipeline' })
    .locator(`xpath=.//div[dt[starts-with(normalize-space(.), "${label}")]]/dd[1]`);

function expectNoRawEmail(text: string): void {
  for (const value of RAW_EMAILS) expect(text).not.toContain(value);
}

/** Types a question, then presses Enter to send it. */
async function ask(page: Page, question: string): Promise<void> {
  const box = page.getByLabel('Ask a question about this project');
  await box.fill(question);
  await box.press('Enter');
}

test('the dashboard sums up the project and the assistant answers with sources', async ({
  page,
}) => {
  test.setTimeout(600_000);
  expect(RAW_EMAILS.length).toBeGreaterThan(0);

  // Setup: mapped, grouped and approved customers, approved SQL that ran, one quality report.
  const projectPath = await projectWithProfiledSources(page, 'Dashboard');
  await approveAllMappings(page, projectPath);
  await runMatchingSteps(page, projectPath);
  await expect(page.getByRole('heading', { name: 'Customers found' })).toBeVisible();
  await approveAllHigh(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Customers found' })).toBeVisible();
  const peopleFound = await matchingCard(page, 'People found');
  const approved = await matchingCard(page, 'Approved');
  expect(peopleFound).toBeGreaterThan(0);
  await approveAndRunSql(page, projectPath);
  const qualityStatus = await runQualityChecks(page, projectPath);

  // ---- Dashboard: the numbers agree with the Matching and Data quality pages.
  await page.goto(`${projectPath}/dashboard`);
  await expect(page.getByRole('heading', { level: 2, name: 'Pipeline' })).toBeVisible();
  await expect(dashboardStat(page, 'Customers')).toHaveText(peopleFound.toLocaleString('en-US'));
  await expect(dashboardStat(page, 'Approved customers')).toHaveText(
    approved.toLocaleString('en-US'),
  );
  await expect(dashboardStat(page, 'Latest quality check')).toHaveText(qualityStatus);
  await expect(dashboardStat(page, 'Latest SQL')).not.toHaveText('');
  await expect(
    page.getByRole('heading', { name: /measured on synthetic test data/ }),
  ).toBeVisible();

  // Time period by keyboard: 30 days -> 7 days -> 90 days; every section still shows.
  const sections = ['Pipeline', 'Data quality', 'Human review', 'Job health'];
  await page.getByRole('radio', { name: 'Last 30 days' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: 'Last 7 days' })).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Last 90 days' })).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Updating…' })).toHaveCount(0, {
    timeout: 15_000,
  });
  for (const name of sections) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  await expect(dashboardStat(page, 'Customers')).toHaveText(peopleFound.toLocaleString('en-US'));

  expectNoRawEmail(await announcedText(page));
  await snapshot(page, '11-dashboard');
  expect(await axeViolations(page)).toEqual([]);

  // The next-step link opens the step it names.
  const goTo = page
    .getByRole('region', { name: 'Next step' })
    .getByRole('link', { name: /^Go to / });
  const stepLabel = (await goTo.innerText()).replace(/^Go to /, '').trim();
  const stepTitle = STEP_TITLES[stepLabel];
  if (!stepTitle) throw new Error(`Unexpected next step "${stepLabel}"`);
  await goTo.click();
  await expect(page.getByRole('heading', { level: 1, name: stepTitle })).toBeVisible();

  // ---- Assistant: build the project knowledge when it is not built yet.
  await page.goto(`${projectPath}/assistant`);
  const knowledge = page.getByRole('region', { name: 'Project knowledge' });
  await expect(
    knowledge.getByRole('button', { name: /^(Build|Rebuild) knowledge$/ }),
  ).toBeVisible();
  const build = knowledge.getByRole('button', { name: 'Build knowledge', exact: true });
  if (await build.isVisible()) await build.click();
  await expect(knowledge.getByText(/pieces of knowledge/)).toBeVisible({ timeout: JOB_TIMEOUT });
  const box = page.getByLabel('Ask a question about this project');
  await expect(box).toBeEnabled();

  // Keyboard: Shift+Enter adds a line without sending; Enter sends.
  const turns = page.getByRole('article', { name: 'Question and answer' });
  await box.fill('Why did PIN completeness fail?');
  await box.press('Shift+Enter');
  await expect(box).toHaveValue('Why did PIN completeness fail?\n');
  await expect(turns).toHaveCount(0);
  await box.press('Backspace');
  await box.press('Enter');
  await expect(turns).toHaveCount(1, { timeout: 60_000 });
  await expect(box).toHaveValue('');
  const answer = turns.first();
  const sources = answer.getByRole('list', { name: 'Sources' }).getByRole('listitem');
  await expect(sources.first()).toBeVisible();
  expect(await sources.count()).toBeGreaterThanOrEqual(1);
  await expect(answer.getByRole('link', { name: /^Source \d+$/ }).first()).toBeVisible();

  // A question the project knowledge cannot answer gets the friendly message.
  await ask(page, 'What is the weather forecast on Mars tomorrow?');
  await expect(turns).toHaveCount(2, { timeout: 60_000 });
  await expect(turns.nth(1)).toContainText("Couldn't answer this one");
  await expect(turns.nth(1)).toContainText(
    /couldn't find enough in the project knowledge|doesn't hold the answer/,
  );

  // With an answer shown: nothing personal announced, and no accessibility violations.
  expectNoRawEmail(await announcedText(page));
  await snapshot(page, '12-assistant');
  expect(await axeViolations(page)).toEqual([]);

  // History lists the conversation by its first question.
  const history = page.getByRole('list', { name: 'Your conversations' });
  const conversation = history.getByRole('button', {
    name: 'Open conversation: Why did PIN completeness fail?',
  });
  await expect(conversation).toBeVisible();

  // A Data quality source opens that page; a design doc shows its title and section instead.
  const toQuality = answer.getByRole('link', { name: /^Open source \d+ in Data quality$/ });
  if ((await toQuality.count()) > 0) {
    await toQuality.first().click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Data quality report' }),
    ).toBeVisible();
    await page.goBack();
    await expect(box).toBeEnabled();
    await conversation.click();
    await expect(turns).toHaveCount(2);
  } else {
    await expect(sources.filter({ hasText: 'Design doc' }).first()).toContainText('section');
  }

  // A question holding a customer's email is refused and the email is not kept anywhere.
  const email = RAW_EMAILS[0] ?? '';
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(turns).toHaveCount(0);
  await ask(page, `Which customer has the email ${email}?`);
  await expect(turns).toHaveCount(1, { timeout: 60_000 });
  await expect(turns.first()).toContainText("I can't use customer details");
  await expect(history.getByRole('listitem')).toHaveCount(2);
  expect(await history.innerText()).not.toContain(email);
  expect(await page.locator('body').innerText()).not.toContain(email);
  await expect(box).toHaveValue('');
  expectNoRawEmail(await announcedText(page));
});
