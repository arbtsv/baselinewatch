// The demo scenario: it signs in to the invented demo portal and measures three steps.
// Replace the steps with those of your own portal; every measure() name needs an entry in baselines.json.

import { test, expect } from 'baselinewatch';

test('sign in and open the account pages', async ({ page, account, measure, fillSecret }) => {
  await page.goto('/');
  await fillSecret(page.getByLabel('Login'), account.login);
  await fillSecret(page.getByLabel('Password'), account.password);

  await measure('login_ms', async () => {
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  });

  await measure('overview_ms', async () => {
    await page.getByRole('link', { name: 'Account overview' }).click();
    await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  });

  await measure('history_ms', async () => {
    await page.getByRole('link', { name: 'Operation history' }).click();
    await expect(page.getByRole('heading', { name: 'Operation history' })).toBeVisible();
  });
});
