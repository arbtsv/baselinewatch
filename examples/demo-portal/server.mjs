// An invented, offline test bench for baselinewatch. It is not a real
// application: the sign-in, the pages, the texts and the account are made up so
// that a monitoring scenario has something to run against.
//
// The portal listens on 127.0.0.1 only. Mode "broken" shows a typed password in
// clear text, so it must never be reachable from another machine.
//
// Run: node server.mjs --port <0-65535> --mode <ok|slowOnce|slowAlways|loginError|broken>
//
// Modes:
//   ok          everything works and answers immediately
//   slowOnce    the first signed-in render of /overview after start is slow
//   slowAlways  every signed-in render of /overview is slow
//   loginError  a correct sign-in is rejected with a visible message
//   broken      the password field shows clear text and the sign-in never succeeds
import http from 'node:http';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

export const DEMO_ACCOUNT = Object.freeze({
  login: 'demo-operator',
  password: 'demo-password-not-secret',
});
export const MODES = Object.freeze(['ok', 'slowOnce', 'slowAlways', 'loginError', 'broken']);
export const SLOW_DELAY_MS = 1500;

const HOST = '127.0.0.1';
const BODY_LIMIT_BYTES = 10 * 1024;
const SESSION_COOKIE = 'demo_session';

/**
 * Reads the launch arguments. Throws an Error whose message names the bad flag.
 * @param {string[]} argv arguments after the script name
 * @returns {{ port: number, mode: string }}
 */
export function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { port: { type: 'string' }, mode: { type: 'string' } },
      strict: true,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A value that starts with a dash (for example "--port -1") makes parseArgs
    // complain about ambiguity; report it as the invalid value it is.
    const flag = /Option '--(port|mode)\b/.exec(message)?.[1];
    if (flag !== undefined) {
      const value = argv[argv.indexOf(`--${flag}`) + 1] ?? '';
      throw new Error(flag === 'port' ? invalidPortMessage(value) : invalidModeMessage(value));
    }
    throw new Error(message);
  }
  const rawPort = values.port;
  const port = typeof rawPort === 'string' && /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(invalidPortMessage(rawPort));
  }
  const mode = values.mode;
  if (typeof mode !== 'string' || !MODES.includes(mode)) {
    throw new Error(invalidModeMessage(mode));
  }
  return { port, mode };
}

function invalidPortMessage(value) {
  return `invalid --port "${value ?? ''}" (an integer 0-65535; 0 picks a free port)`;
}

function invalidModeMessage(value) {
  return `invalid --mode "${value ?? ''}" (one of ${MODES.join('|')})`;
}

/** Escapes a value for use in HTML text and in quoted attribute values. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
body { font-family: Arial, Helvetica, sans-serif; margin: 0; background: #f4f6f8; color: #1d2733; }
.bench-shell { max-width: 640px; margin: 48px auto; padding: 24px 32px; background: #ffffff; border: 1px solid #d5dbe1; }
.bench-nav a { margin-right: 16px; color: #1f5f99; }
.bench-field { margin: 12px 0; }
.bench-field label { display: block; margin-bottom: 4px; }
.bench-field input { width: 100%; box-sizing: border-box; padding: 6px; }
.bench-alert { padding: 8px 12px; background: #fdecea; border: 1px solid #c0392b; color: #7b1e14; }
.bench-table { border-collapse: collapse; width: 100%; }
.bench-table th, .bench-table td { border-bottom: 1px solid #d5dbe1; padding: 6px; text-align: left; }
`;

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} - Demo Portal</title>
<style>${STYLE}</style>
</head>
<body>
<main class="bench-shell">
${body}
</main>
</body>
</html>
`;
}

function loginPage({ mode, alert = false, login = '', password = '', echo = false }) {
  const passwordType = mode === 'broken' ? 'text' : 'password';
  const loginValue = echo ? ` value="${escapeHtml(login)}"` : '';
  const passwordValue = echo ? ` value="${escapeHtml(password)}"` : '';
  const message = alert
    ? '\n<p role="alert" class="bench-alert">Sign-in rejected: the login or password is not accepted.</p>'
    : '';
  return layout(
    'Sign in',
    `<h1>Sign in</h1>${message}
<form method="post" action="/login">
<div class="bench-field"><label for="login">Login</label>
<input id="login" name="login" type="text" autocomplete="username"${loginValue}></div>
<div class="bench-field"><label for="password">Password</label>
<input id="password" name="password" type="${passwordType}" autocomplete="current-password"${passwordValue}></div>
<button type="submit">Sign in</button>
</form>`,
  );
}

const NAV = `<nav class="bench-nav"><a href="/overview">Account overview</a><a href="/history">Operation history</a></nav>`;

function homePage() {
  return layout('Welcome', `<h1>Welcome</h1>\n${NAV}\n<p>Pick a page from the menu above.</p>`);
}

function overviewPage() {
  return layout(
    'Account overview',
    `<h1>Account overview</h1>
${NAV}
<table class="bench-table">
<thead><tr><th>Account</th><th>Balance</th></tr></thead>
<tbody>
<tr><td>Main account</td><td>1 250.00</td></tr>
<tr><td>Savings</td><td>8 400.00</td></tr>
</tbody>
</table>`,
  );
}

function historyPage() {
  return layout(
    'Operation history',
    `<h1>Operation history</h1>
${NAV}
<table class="bench-table">
<thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
<tbody>
<tr><td>2026-03-02</td><td>Transfer to Savings</td><td>-300.00</td></tr>
<tr><td>2026-03-05</td><td>Utility bill</td><td>-64.50</td></tr>
<tr><td>2026-03-09</td><td>Refund from Example Shop</td><td>+22.00</td></tr>
</tbody>
</table>`,
  );
}

function notFoundPage() {
  return layout('Not found', '<h1>Not found</h1>\n<p>There is no such page.</p>');
}

function methodNotAllowedPage() {
  return layout('Method not allowed', '<h1>Method not allowed</h1>');
}

function tooLargePage() {
  return layout('Request too large', '<h1>Request too large</h1>');
}

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function redirect(res, location, extraHeaders = {}) {
  send(res, 303, '', { location, ...extraHeaders });
}

function readSessionToken(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Collects a request body. Resolves with the text, or with null once the body
 * grows past the limit (the caller answers 413).
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        settled = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

/**
 * Creates the portal server for one mode. The server is not listening yet.
 * Sessions and the render counter live in this server instance only.
 * @param {string} mode one of MODES
 * @returns {import('node:http').Server}
 */
export function createPortal(mode) {
  if (!MODES.includes(mode)) throw new Error(`invalid --mode "${mode}" (one of ${MODES.join('|')})`);
  const sessions = new Set();
  let overviewRenders = 0;

  const isSignedIn = (req) => {
    const token = readSessionToken(req);
    return token !== undefined && sessions.has(token);
  };

  async function handleLogin(req, res) {
    const body = await readBody(req);
    if (body === null) {
      send(res, 413, tooLargePage(), { connection: 'close' });
      return;
    }
    const form = new URLSearchParams(body);
    const login = form.get('login') ?? '';
    const password = form.get('password') ?? '';

    if (mode === 'broken') {
      send(res, 200, loginPage({ mode, login, password, echo: true }));
      return;
    }
    const correct = login === DEMO_ACCOUNT.login && password === DEMO_ACCOUNT.password;
    if (mode === 'loginError' || !correct) {
      send(res, 200, loginPage({ mode, alert: true }));
      return;
    }
    const token = crypto.randomBytes(16).toString('hex');
    sessions.add(token);
    redirect(res, '/home', {
      'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
    });
  }

  async function handleOverview(res) {
    const renderIndex = overviewRenders;
    overviewRenders += 1;
    const slow = mode === 'slowAlways' || (mode === 'slowOnce' && renderIndex === 0);
    if (slow) await sleep(SLOW_DELAY_MS);
    send(res, 200, overviewPage());
  }

  async function route(req, res) {
    const { pathname } = new URL(req.url ?? '/', `http://${HOST}`);
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'POST') {
      send(res, 405, methodNotAllowedPage(), { allow: 'GET, POST' });
      return;
    }
    if (method === 'POST') {
      if (pathname !== '/login') {
        send(res, 405, methodNotAllowedPage(), { allow: 'GET' });
        return;
      }
      await handleLogin(req, res);
      return;
    }
    if (pathname === '/login') {
      send(res, 405, methodNotAllowedPage(), { allow: 'POST' });
      return;
    }
    if (pathname === '/') {
      send(res, 200, loginPage({ mode }));
      return;
    }
    if (pathname === '/home' || pathname === '/overview' || pathname === '/history') {
      if (!isSignedIn(req)) {
        redirect(res, '/');
        return;
      }
      if (pathname === '/home') send(res, 200, homePage());
      else if (pathname === '/history') send(res, 200, historyPage());
      else await handleOverview(res);
      return;
    }
    send(res, 404, notFoundPage());
  }

  return http.createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, layout('Error', '<h1>Something went wrong</h1>'));
      else res.end();
    });
  });
}

if (import.meta.main) {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const server = createPortal(cli.mode);
  server.on('error', (error) => {
    console.error(`cannot listen on ${HOST}:${cli.port}: ${error.code ?? error.message}`);
    process.exit(1);
  });
  server.listen(cli.port, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : cli.port;
    console.log(`listening on http://127.0.0.1:${port} (${cli.mode})`);
  });
}
