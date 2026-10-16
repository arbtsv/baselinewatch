// Tests for .githooks/pre-push: each case builds a throwaway repository with a
// bare remote, a private denylist and a stub reviewer, then runs `git push`.
// Run: node --test "test/hook/*.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const posix = (p) => p.replaceAll('\\', '/');
const hooksDir = posix(path.join(repoRoot, '.githooks'));
const policy = fs.readFileSync(path.join(repoRoot, 'docs', 'public-hygiene.md'), 'utf8');

const DENIED = 'zorblaxcorp';
const DENIED_CYRILLIC = 'тестовыйтермин';

// Image markers are assembled at runtime so this file passes the real hook.
const DATA_URI = 'data:' + 'image/png;base64,iVBORw0KGgo=';
const BASE64_RUN = 'QUJD'.repeat(60);
const SVG_IMAGE = '<svg xmlns="http://www.w3.org/2000/svg"><' + 'image href="a.png"/></svg>\n';
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d, 0x00, 0xff]);

// Stub reviewer: answers LEAK when the reviewed commit contains LEAKME.
const STUB = `#!/bin/sh
input=$(cat)
echo call >>"$STUB_CALLS"
case "$STUB_MODE" in
  sleep) sleep 8 ;;
  garbage) echo "Looks fine to me."; exit 0 ;;
  fail) echo "not logged in" >&2; exit 1 ;;
esac
if printf '%s' "$input" | grep -q LEAKME; then
  printf 'VERDICT: LEAK\\nfile.txt: 3 - test finding\\n'
else
  printf '\\nVERDICT: CLEAN\\n'
fi
`;

function run(cwd, args, env = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function git(cwd, ...args) {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function setup({ privateDir = true, denylist = `# test terms\n${DENIED}\n${DENIED_CYRILLIC}\n` } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-hook-'));
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(dir, 'init', '-q', '-b', 'main', 'work');
  for (const [key, value] of [
    ['user.name', 'Test Author'],
    ['user.email', 'author@example.com'],
    ['core.hooksPath', hooksDir],
    ['core.autocrlf', 'false'],
  ]) git(work, 'config', key, value);
  git(work, 'remote', 'add', 'origin', posix(path.join(dir, 'remote.git')));
  write(work, 'docs/public-hygiene.md', policy);
  write(work, '.gitignore', '.private/\n');
  if (privateDir) write(work, '.private/leak-guard/denylist.txt', denylist);
  write(dir, 'claude-stub', STUB);
  fs.chmodSync(path.join(dir, 'claude-stub'), 0o755);
  const ctx = {
    dir,
    work,
    stub: posix(path.join(dir, 'claude-stub')),
    callsFile: path.join(dir, 'calls.log'),
  };
  commit(ctx, {}, 'Initial commit');
  return ctx;
}

function commit(ctx, files, message, ...gitArgs) {
  for (const [rel, content] of Object.entries(files)) write(ctx.work, rel, content);
  git(ctx.work, 'add', '-A');
  git(ctx.work, ...gitArgs, 'commit', '-q', '--allow-empty', '-m', message);
  return git(ctx.work, 'rev-parse', 'HEAD');
}

function push(ctx, env = {}, ref = 'HEAD:refs/heads/feature') {
  return run(ctx.work, ['push', '-q', 'origin', ref], {
    BASELINEWATCH_LEAK_CLAUDE: ctx.stub,
    BASELINEWATCH_LEAK_NO_TTY: '1',
    STUB_CALLS: posix(ctx.callsFile),
    ...env,
  });
}

function calls(ctx) {
  return fs.existsSync(ctx.callsFile) ? fs.readFileSync(ctx.callsFile, 'utf8').trim().split('\n').length : 0;
}

function verdict(ctx, sha) {
  return fs.readFileSync(path.join(ctx.work, '.git', 'leak-review', `${sha}.txt`), 'utf8');
}

function assertRefused(r, pattern) {
  assert.equal(r.status, 1, `expected push to be refused, stderr:\n${r.stderr}`);
  assert.match(r.stderr, pattern);
  assert.match(r.stderr, /push cancelled/);
}

describe('pre-push', { concurrency: 8 }, () => {
  test('clean commits pass and leave a CLEAN verdict for the head', () => {
    const ctx = setup();
    const head = commit(ctx, { 'src/a.txt': 'hello\n' }, 'Add a');
    const r = push(ctx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdict(ctx, head), /^VERDICT: CLEAN\nhead: [0-9a-f]{40}\n/);
    assert.equal(calls(ctx), 2);
  });

  test('a LEAK verdict cancels the push; clean commits are not reviewed twice', () => {
    const ctx = setup();
    commit(ctx, { 'a.txt': 'fine\n' }, 'Add a');
    const bad = commit(ctx, { 'b.txt': 'LEAKME\n' }, 'Add b');
    const refused = push(ctx);
    assertRefused(refused, /possible leak/);
    assert.match(refused.stderr, /^ {2}file\.txt: 3 - test finding$/m);
    assert.match(verdict(ctx, bad), /^VERDICT: LEAK\n/);
    assert.equal(calls(ctx), 3);

    git(ctx.work, 'reset', '-q', '--soft', 'HEAD~1');
    commit(ctx, { 'b.txt': 'fine too\n' }, 'Add b');
    const r = push(ctx);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls(ctx), 4);
  });

  test('nothing new to push needs no review', () => {
    const ctx = setup();
    assert.equal(push(ctx).status, 0);
    assert.equal(push(ctx, {}, 'HEAD:refs/heads/other').status, 0);
    assert.equal(calls(ctx), 1);
  });

  describe('fail-closed', () => {
    test('without .private/', () => {
      const ctx = setup({ privateDir: false });
      assertRefused(push(ctx), /\.private\/ is missing/);
    });

    test('with an empty denylist', () => {
      const ctx = setup({ denylist: '# comments only\n\n   \n' });
      assertRefused(push(ctx), /denylist\.txt is empty/);
    });

    test('without the reviewer', () => {
      const ctx = setup();
      assertRefused(push(ctx, { BASELINEWATCH_LEAK_CLAUDE: posix(path.join(ctx.dir, 'missing')) }), /not found/);
    });

    test('when the reviewer fails', () => {
      const ctx = setup();
      assertRefused(push(ctx, { STUB_MODE: 'fail' }), /reviewer failed/);
    });

    test('when the answer has no VERDICT line', () => {
      const ctx = setup();
      assertRefused(push(ctx, { STUB_MODE: 'garbage' }), /does not start with a VERDICT line/);
    });

    test('when a review call times out', () => {
      const ctx = setup();
      assertRefused(push(ctx, { STUB_MODE: 'sleep', BASELINEWATCH_LEAK_CALL_TIMEOUT: '2' }), /timed out after 2s/);
    });

    test('when the time budget per push is exhausted', () => {
      const ctx = setup();
      assertRefused(push(ctx, { BASELINEWATCH_LEAK_DEADLINE: '0' }), /time budget/);
      assert.equal(calls(ctx), 0);
    });
  });

  describe('limits', () => {
    test('more than 20 new commits', () => {
      const ctx = setup();
      for (let i = 1; i <= 20; i++) commit(ctx, {}, `Commit ${i}`);
      assertRefused(push(ctx), /21 new commits; at most 20/);
    });

    test('direct push to an existing main', () => {
      const ctx = setup();
      const first = push(ctx, {}, 'HEAD:refs/heads/main');
      assert.equal(first.status, 0, first.stderr);
      commit(ctx, { 'a.txt': 'a\n' }, 'Add a');
      assertRefused(push(ctx, {}, 'HEAD:refs/heads/main'), /direct push to main/);
    });
  });

  describe('denylist', () => {
    const cases = [
      ['in an added line', (ctx) => commit(ctx, { 'a.txt': 'see ZorblaxCorp docs\n' }, 'Add a'), /added lines/],
      ['in a Cyrillic added line', (ctx) => commit(ctx, { 'a.txt': 'ТЕСТОВЫЙТЕРМИН\n' }, 'Add a'), /added lines/],
      ['in a commit message', (ctx) => commit(ctx, { 'a.txt': 'a\n' }, `Port from ${DENIED}`), /the message/],
      ['in a file path', (ctx) => commit(ctx, { [`notes/${DENIED}.txt`]: 'a\n' }, 'Add notes'), /file paths/],
      [
        'in the author identity',
        (ctx) => commit(ctx, { 'a.txt': 'a\n' }, 'Add a', '-c', `user.email=dev@${DENIED}.example`),
        /author\/committer/,
      ],
    ];
    for (const [name, make, where] of cases) {
      test(name, () => {
        const ctx = setup();
        make(ctx);
        assertRefused(push(ctx), where);
        assert.equal(calls(ctx), 0, 'the reviewer must not run after a denylist hit');
      });
    }
  });

  describe('images', () => {
    const cases = [
      ['binary file outside docs/img/', { 'assets/logo.png': BINARY }, /binary file assets\/logo\.png/],
      ['image data URI in text', { 'docs/guide.md': `![x](${DATA_URI})\n` }, /data URI/],
      ['long base64 run in text', { 'src/blob.txt': `${BASE64_RUN}\n` }, /base64 run/],
      ['image element inside SVG', { 'docs/diagram.svg': SVG_IMAGE }, /SVG/],
      ['file under docs/img/ without a manifest entry', { 'docs/img/shot.png': BINARY }, /not in docs\/img\/MANIFEST\.txt/],
    ];
    for (const [name, files, pattern] of cases) {
      test(name, () => {
        const ctx = setup();
        commit(ctx, files, 'Add file');
        assertRefused(push(ctx), pattern);
      });
    }

    test('a changed manifest needs a terminal', () => {
      const ctx = setup();
      commit(
        ctx,
        { 'docs/img/shot.png': BINARY, 'docs/img/MANIFEST.txt': `${sha256(BINARY)}  docs/img/shot.png\n` },
        'Add screenshot',
      );
      assertRefused(push(ctx), /no terminal to confirm/);
    });

    test('an image listed in an already published manifest passes; a changed one does not', () => {
      const ctx = setup();
      const second = Buffer.concat([BINARY, Buffer.from([0x01])]);
      commit(
        ctx,
        { 'docs/img/MANIFEST.txt': `${sha256(BINARY)}  docs/img/one.png\n${sha256(second)}  docs/img/two.png\n` },
        'Add manifest',
      );
      // a human pushed the manifest from a terminal earlier
      assert.equal(run(ctx.work, ['push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/feature']).status, 0);

      commit(ctx, { 'docs/img/one.png': BINARY, 'docs/img/two.png': second }, 'Add screenshots');
      const r = push(ctx);
      assert.equal(r.status, 0, r.stderr);

      commit(ctx, { 'docs/img/two.png': BINARY }, 'Replace screenshot');
      assertRefused(push(ctx), /docs\/img\/two\.png .* is not in docs\/img\/MANIFEST\.txt/);
    });
  });

  describe('override', () => {
    const log = '.private/leak-guard/overrides.md';

    test('requires an entry with a reason for the head', () => {
      const ctx = setup();
      const head = commit(ctx, { 'a.txt': 'LEAKME\n' }, 'Add a');
      assertRefused(push(ctx, { BASELINEWATCH_LEAK_OVERRIDE: '1' }), /overrides\.md is missing/);
      write(ctx.work, log, `# log\n\n## 1 ${head}\n\n## 2 other\nreason\n`);
      assertRefused(push(ctx, { BASELINEWATCH_LEAK_OVERRIDE: '1' }), /no entry/);
    });

    test('with an entry writes an OVERRIDE verdict and skips the review', () => {
      const ctx = setup();
      const head = commit(ctx, { 'a.txt': 'LEAKME\n' }, 'Add a');
      write(ctx.work, log, `# log\n\n## 3 ${head}\nfalse positive: test fixture\n`);
      const r = push(ctx, { BASELINEWATCH_LEAK_OVERRIDE: '1' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(verdict(ctx, head), /^VERDICT: OVERRIDE\nhead: [0-9a-f]{40}\noverride-entry: 3\n/);
      assert.equal(calls(ctx), 0);
    });
  });
});
