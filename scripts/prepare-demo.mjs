// Prepares the in-repo demo project: rebuilds the core, packs it into
// examples/demo-portal/vendor/ and installs that tarball into the demo project,
// the same way an integrator consumes it (a vendored tgz plus a Playwright peer
// dependency). When the packed bytes did not change since the last install the
// install is skipped. It also writes examples/demo-portal/env.json when missing.
//
// Run: node scripts/prepare-demo.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'examples', 'demo-portal');
const VENDOR = path.join(DEMO, 'vendor');
const STAMP = path.join(VENDOR, '.stamp');
const DEMO_PACKAGE = path.join(DEMO, 'package.json');
const ENV_FILE = path.join(DEMO, 'env.json');

function log(message) {
  console.log(`prepare-demo: ${message}`);
}

function fail(message) {
  console.error(`prepare-demo: ${message}`);
  process.exit(1);
}

/** Finds the npm CLI script without ever spawning "npm" or "npx" by name. */
function findNpmCli() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && fromEnv.endsWith('.js') && fs.existsSync(fromEnv)) return fromEnv;
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    fail('cannot find the npm CLI script; run this through "npm run" or install npm next to node');
  }
  return found;
}

const NPM_CLI = findNpmCli();

/** Runs npm with node itself and returns stdout; throws with stderr on failure. */
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [NPM_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed (status ${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Lists every file under a directory as paths relative to it. */
function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return found.sort();
}

function buildAndPack() {
  fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
  log('cleaned dist/');
  npm(['run', 'build'], ROOT);
  log('built dist/');

  fs.mkdirSync(VENDOR, { recursive: true });
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', VENDOR], ROOT));
  const fileName = packed[0]?.filename;
  if (typeof fileName !== 'string' || fileName === '') {
    throw new Error('npm pack did not report a file name');
  }
  for (const name of fs.readdirSync(VENDOR)) {
    if (/^baselinewatch-.*\.tgz$/.test(name) && name !== fileName) {
      fs.rmSync(path.join(VENDOR, name), { force: true });
    }
  }
  log(`packed ${fileName}`);
  return fileName;
}

function checkManifest(fileName) {
  const manifest = JSON.parse(fs.readFileSync(DEMO_PACKAGE, 'utf8'));
  if (manifest.dependencies?.baselinewatch !== `file:vendor/${fileName}`) {
    fail(
      'examples/demo-portal/package.json must reference file:vendor/<name>; ' +
        `update the version there (expected file:vendor/${fileName})`,
    );
  }
}

function installIfChanged(fileName) {
  const tgzBytes = fs.readFileSync(path.join(VENDOR, fileName));
  const hash = sha256(tgzBytes);
  const stamped = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8').trim() : '';
  const installed =
    fs.existsSync(path.join(DEMO, 'node_modules', 'baselinewatch', 'package.json')) &&
    fs.existsSync(path.join(DEMO, 'node_modules', '@playwright', 'test', 'package.json'));
  if (stamped === hash && installed) {
    log('core unchanged, install skipped');
    return;
  }
  const savedManifest = fs.readFileSync(DEMO_PACKAGE);
  log(`installing ./vendor/${fileName} into examples/demo-portal`);
  npm(['install', `./vendor/${fileName}`, '--no-audit', '--no-fund'], DEMO);
  if (!fs.readFileSync(DEMO_PACKAGE).equals(savedManifest)) {
    fs.writeFileSync(DEMO_PACKAGE, savedManifest);
  }
  fs.writeFileSync(STAMP, `${hash}\n`);
  log('installed');
}

function checkFreshInstall() {
  const source = path.join(ROOT, 'dist');
  const target = path.join(DEMO, 'node_modules', 'baselinewatch', 'dist');
  for (const relative of listFiles(source)) {
    const copy = path.join(target, relative);
    if (!fs.existsSync(copy) || !fs.readFileSync(copy).equals(fs.readFileSync(path.join(source, relative)))) {
      fail('the demo still has an old core installed');
    }
  }
  log('installed core matches dist/');
}

async function writeEnvIfMissing() {
  if (fs.existsSync(ENV_FILE)) {
    log('env.json exists, left untouched');
    return;
  }
  const portal = await import(pathToFileURL(path.join(DEMO, 'server.mjs')).href);
  const env = {
    environment: 'demo',
    locale: 'en',
    account: { login: portal.DEMO_ACCOUNT.login, password: portal.DEMO_ACCOUNT.password },
    retention_days: 30,
    scenarios: { demo: { nodes: { 'node-1': 'http://127.0.0.1:4101/' } } },
  };
  fs.writeFileSync(ENV_FILE, `${JSON.stringify(env, null, 2)}\n`);
  log('wrote examples/demo-portal/env.json');
  log('start the portal with: node server.mjs --port 4101 --mode ok (in examples/demo-portal)');
}

try {
  const fileName = buildAndPack();
  checkManifest(fileName);
  installIfChanged(fileName);
  checkFreshInstall();
  await writeEnvIfMissing();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
