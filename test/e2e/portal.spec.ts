// Checks the five demo portal modes in a real browser, one fresh portal per test.
//
// Run: npm run e2e -- test/e2e/portal.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { loadPortalModule, startPortal, type PortalMode, type RunningPortal } from '../helpers/portal.ts';

async function withPortal(mode: PortalMode, fn: (portal: RunningPortal) => Promise<void>): Promise<void> {
  const portal = await startPortal(mode);
  try {
    await fn(portal);
  } finally {
    await portal.stop();
  }
}

async function openLogin(page: Page, portal: RunningPortal): Promise<void> {
  await page.goto(new URL('/', portal.url).href);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

async function submitLogin(page: Page, login: string, password: string): Promise<void> {
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function timedGoto(page: Page, url: string): Promise<number> {
  const started = performance.now();
  await page.goto(url);
  return performance.now() - started;
}

test('ok: signs in and reaches all three pages', async ({ page }) => {
  const { DEMO_ACCOUNT } = await loadPortalModule();
  await withPortal('ok', async (portal) => {
    await openLogin(page, portal);
    await submitLogin(page, DEMO_ACCOUNT.login, DEMO_ACCOUNT.password);
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();

    await page.getByRole('link', { name: 'Account overview' }).click();
    await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();

    await page.getByRole('link', { name: 'Operation history' }).click();
    await expect(page.getByRole('heading', { name: 'Operation history' })).toBeVisible();
  });
});

test('slowOnce: only the first overview render is slow', async ({ page }) => {
  const { DEMO_ACCOUNT, SLOW_DELAY_MS } = await loadPortalModule();
  await withPortal('slowOnce', async (portal) => {
    await openLogin(page, portal);
    await submitLogin(page, DEMO_ACCOUNT.login, DEMO_ACCOUNT.password);
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();

    const overview = new URL('/overview', portal.url).href;
    const first = await timedGoto(page, overview);
    expect(first).toBeGreaterThanOrEqual(SLOW_DELAY_MS - 300);
    const second = await timedGoto(page, overview);
    expect(second).toBeLessThan(1000);
  });
});

test('slowAlways: every overview render is slow', async ({ page }) => {
  const { DEMO_ACCOUNT, SLOW_DELAY_MS } = await loadPortalModule();
  await withPortal('slowAlways', async (portal) => {
    await openLogin(page, portal);
    await submitLogin(page, DEMO_ACCOUNT.login, DEMO_ACCOUNT.password);
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();

    const overview = new URL('/overview', portal.url).href;
    const first = await timedGoto(page, overview);
    expect(first).toBeGreaterThanOrEqual(SLOW_DELAY_MS - 300);
    const second = await timedGoto(page, overview);
    expect(second).toBeGreaterThanOrEqual(SLOW_DELAY_MS - 300);
  });
});

test('loginError: a correct sign-in is rejected with a visible alert', async ({ page }) => {
  const { DEMO_ACCOUNT } = await loadPortalModule();
  await withPortal('loginError', async (portal) => {
    await openLogin(page, portal);
    await submitLogin(page, DEMO_ACCOUNT.login, DEMO_ACCOUNT.password);
    await expect(page.getByRole('alert')).toContainText('Sign-in rejected');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome' })).toHaveCount(0);
  });
});

test('broken: the login page stays and the password is shown as clear text', async ({ page }) => {
  const { DEMO_ACCOUNT } = await loadPortalModule();
  await withPortal('broken', async (portal) => {
    await openLogin(page, portal);
    const password = page.getByLabel('Password');
    await expect(password).toHaveAttribute('type', 'text');

    await submitLogin(page, DEMO_ACCOUNT.login, DEMO_ACCOUNT.password);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(password).toHaveAttribute('type', 'text');
    expect(await password.inputValue()).toBe(DEMO_ACCOUNT.password);
    await expect(page.getByRole('heading', { name: 'Welcome' })).toHaveCount(0);
  });
});
