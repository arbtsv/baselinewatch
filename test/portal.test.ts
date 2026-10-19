// Tests for the offline demo portal: every mode is started as a real process and
// exercised over HTTP on 127.0.0.1.
// Run: node --test test/portal.test.ts
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { loadPortalModule, startPortal } from './helpers/portal.ts';
import type { PortalModule, RunningPortal } from './helpers/portal.ts';

type SignInResult = { status: number; location: string | null; cookie: string | null; html: string };

async function signIn(base: string, login: string, password: string): Promise<SignInResult> {
  const response = await fetch(new URL('/login', base), {
    method: 'POST',
    body: new URLSearchParams({ login, password }),
    redirect: 'manual',
  });
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('demo_session='));
  return {
    status: response.status,
    location: response.headers.get('location'),
    cookie: setCookie ? setCookie.split(';')[0] : null,
    html: await response.text(),
  };
}

function get(base: string, pathname: string, cookie?: string | null): Promise<Response> {
  return fetch(new URL(pathname, base), {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
}

describe('ok mode', () => {
  let portal: RunningPortal;
  let account: { login: string; password: string };

  before(async () => {
    account = (await loadPortalModule()).DEMO_ACCOUNT;
    portal = await startPortal('ok');
  });
  after(async () => {
    await portal?.stop();
  });

  test('the login page has a password input of type password', async () => {
    const response = await get(portal.url, '/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html; charset=utf-8$/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /<h1>Sign in<\/h1>/);
    assert.match(html, /<input id="password"[^>]*type="password"/);
    assert.doesNotMatch(html, /role="alert"/);
  });

  test('a correct sign-in redirects to /home and sets a session cookie', async () => {
    const result = await signIn(portal.url, account.login, account.password);
    assert.equal(result.status, 303);
    assert.equal(result.location, '/home');
    assert.match(result.cookie ?? '', /^demo_session=[0-9a-f]{32}$/);
  });

  test('the three pages are served to a signed-in visitor', async () => {
    const { cookie } = await signIn(portal.url, account.login, account.password);
    for (const [pathname, heading] of [
      ['/home', 'Welcome'],
      ['/overview', 'Account overview'],
      ['/history', 'Operation history'],
    ]) {
      const response = await get(portal.url, pathname, cookie);
      assert.equal(response.status, 200, pathname);
      assert.match(await response.text(), new RegExp(`<h1>${heading}</h1>`), pathname);
    }
  });

  test('pages redirect to the login page without a session', async () => {
    for (const pathname of ['/home', '/overview', '/history']) {
      const response = await get(portal.url, pathname);
      assert.equal(response.status, 303, pathname);
      assert.equal(response.headers.get('location'), '/', pathname);
    }
    const unknown = await get(portal.url, '/overview', 'demo_session=not-a-real-token');
    assert.equal(unknown.status, 303);
  });

  const rejected: Array<[string, (a: { login: string; password: string }) => [string, string]]> = [
    ['a wrong password', (a) => [a.login, `${a.password}x`]],
    ['a login with a trailing space', (a) => [`${a.login} `, a.password]],
    ['an upper-cased login', (a) => [a.login.toUpperCase(), a.password]],
    ['empty fields', () => ['', '']],
  ];
  for (const [name, make] of rejected) {
    test(`rejected with an alert and no cookie: ${name}`, async () => {
      const [login, password] = make(account);
      const result = await signIn(portal.url, login, password);
      assert.equal(result.status, 200);
      assert.match(result.html, /role="alert"/);
      assert.equal(result.cookie, null);
    });
  }

  test('a wrong password sets no cookie header at all', async () => {
    const response = await fetch(new URL('/login', portal.url), {
      method: 'POST',
      body: new URLSearchParams({ login: account.login, password: 'wrong' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.match(await response.text(), /role="alert"/);
  });

  test('a missing form body is rejected like empty fields', async () => {
    const response = await fetch(new URL('/login', portal.url), { method: 'POST', redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.match(await response.text(), /role="alert"/);
  });

  test('an unknown path is a 404 page', async () => {
    const response = await get(portal.url, '/nope');
    assert.equal(response.status, 404);
  });

  test('other methods are refused with 405', async () => {
    const response = await fetch(new URL('/', portal.url), { method: 'DELETE' });
    assert.equal(response.status, 405);
  });
});

async function timedGet(base: string, pathname: string, cookie: string | null): Promise<number> {
  const started = performance.now();
  const response = await get(base, pathname, cookie);
  await response.text();
  assert.equal(response.status, 200, pathname);
  return performance.now() - started;
}

describe('slowOnce mode', () => {
  let portal: RunningPortal;
  let portalModule: PortalModule;

  before(async () => {
    portalModule = await loadPortalModule();
    portal = await startPortal('slowOnce');
  });
  after(async () => {
    await portal?.stop();
  });

  test('only the first overview render is slow', async () => {
    const { DEMO_ACCOUNT, SLOW_DELAY_MS } = portalModule;
    const { cookie } = await signIn(portal.url, DEMO_ACCOUNT.login, DEMO_ACCOUNT.password);
    assert.ok(cookie);
    // Other pages, redirects and unknown paths must not use up the slow render.
    assert.ok((await timedGet(portal.url, '/history', cookie)) < 600);
    assert.ok((await timedGet(portal.url, '/home', cookie)) < 600);
    assert.equal((await get(portal.url, '/overview')).status, 303);
    assert.equal((await get(portal.url, '/favicon.ico', cookie)).status, 404);

    const first = await timedGet(portal.url, '/overview', cookie);
    assert.ok(first >= SLOW_DELAY_MS - 300, `first overview took ${first} ms`);
    const second = await timedGet(portal.url, '/overview', cookie);
    assert.ok(second < 600, `second overview took ${second} ms`);
  });
});

describe('slowAlways mode', () => {
  let portal: RunningPortal;
  let portalModule: PortalModule;

  before(async () => {
    portalModule = await loadPortalModule();
    portal = await startPortal('slowAlways');
  });
  after(async () => {
    await portal?.stop();
  });

  test('every overview render is slow and the other pages are not', async () => {
    const { DEMO_ACCOUNT, SLOW_DELAY_MS } = portalModule;
    const { cookie } = await signIn(portal.url, DEMO_ACCOUNT.login, DEMO_ACCOUNT.password);
    assert.ok(cookie);
    for (const attempt of [1, 2]) {
      const elapsed = await timedGet(portal.url, '/overview', cookie);
      assert.ok(elapsed >= SLOW_DELAY_MS - 300, `overview ${attempt} took ${elapsed} ms`);
    }
    const history = await timedGet(portal.url, '/history', cookie);
    assert.ok(history < 600, `history took ${history} ms`);
  });
});

describe('loginError mode', () => {
  let portal: RunningPortal;
  let portalModule: PortalModule;

  before(async () => {
    portalModule = await loadPortalModule();
    portal = await startPortal('loginError');
  });
  after(async () => {
    await portal?.stop();
  });

  test('a correct sign-in is rejected with an alert and no cookie', async () => {
    const { DEMO_ACCOUNT } = portalModule;
    const response = await fetch(new URL('/login', portal.url), {
      method: 'POST',
      body: new URLSearchParams({ login: DEMO_ACCOUNT.login, password: DEMO_ACCOUNT.password }),
      redirect: 'manual',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), []);
    const html = await response.text();
    assert.match(html, /role="alert"/);
    assert.match(html, /<input id="password"[^>]*type="password"/);
    assert.equal((await get(portal.url, '/home')).status, 303);
  });
});

describe('broken mode', () => {
  let portal: RunningPortal;
  let portalModule: PortalModule;

  before(async () => {
    portalModule = await loadPortalModule();
    portal = await startPortal('broken');
  });
  after(async () => {
    await portal?.stop();
  });

  const passwordTag = (html: string): string => {
    const tag = /<input\b[^>]*\bid="password"[^>]*>/.exec(html);
    assert.ok(tag, 'the page has an input with id="password"');
    return tag[0];
  };

  test('the login page shows the password input as plain text', async () => {
    const html = await (await get(portal.url, '/')).text();
    assert.match(passwordTag(html), /\btype="text"/);
  });

  test('a sign-in attempt stays on the login page with the password in the field', async () => {
    const { DEMO_ACCOUNT } = portalModule;
    const response = await fetch(new URL('/login', portal.url), {
      method: 'POST',
      body: new URLSearchParams({ login: DEMO_ACCOUNT.login, password: DEMO_ACCOUNT.password }),
      redirect: 'manual',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), []);
    const html = await response.text();
    const tag = passwordTag(html);
    assert.match(tag, /\btype="text"/);
    assert.ok(tag.includes(`value="${DEMO_ACCOUNT.password}"`), 'the password is the input value');
    assert.match(html, new RegExp(`id="login"[^>]*value="${DEMO_ACCOUNT.login}"`));
    assert.doesNotMatch(html, /role="alert"/);
    assert.equal((await get(portal.url, '/home')).status, 303);
  });

  test('echoed values are escaped', async () => {
    const response = await fetch(new URL('/login', portal.url), {
      method: 'POST',
      body: new URLSearchParams({ login: `<b>x</b>&"'`, password: `"><script>1</script>` }),
      redirect: 'manual',
    });
    const html = await response.text();
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;&amp;&quot;&#39;'));
    assert.ok(!html.includes('<b>x</b>'));
    assert.ok(!html.includes('<script>1</script>'));
  });
});

describe('loopback only', () => {
  let portal: RunningPortal;

  before(async () => {
    portal = await startPortal('ok');
  });
  after(async () => {
    await portal?.stop();
  });

  function firstExternalAddress(): string | undefined {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const entry of addresses ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) return entry.address;
      }
    }
    return undefined;
  }

  test('a connection on a non-loopback interface does not reach the portal', async (t) => {
    const address = firstExternalAddress();
    if (address === undefined) {
      t.skip('no non-loopback interface');
      return;
    }
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: address, port: portal.port });
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve('timeout');
      });
      socket.once('error', () => {
        socket.destroy();
        resolve('refused');
      });
    });
    assert.notEqual(outcome, 'connected', `the portal answered on ${address}`);
  });
});
