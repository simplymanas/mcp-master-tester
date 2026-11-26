// Weight budget: this project's promise is to stay small. These tests fail when the published package
// grows past its budget, gains a dependency, or starts shipping files it shouldn't. If a change really
// needs more room, raise the number here in the same pull request and say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// Raised from 60 kB at 1.7.0 (config import, outputSchema results, Markdown copy), at 1.8.0 for the
// lockfile diff (public/diff.js, 10 kB of source), and at 1.9.0 for tool-selection evals (public/evals.js
// and the eval command, 17 kB of source). Contributor docs and the detailed smoke-test reference moved
// out of the README to the website and CONTRIBUTING.md to keep the README itself small.
const MAX_TARBALL_BYTES = 76_000;    // the .tgz that npm downloads (55 kB at 1.4.0, 64 kB at 1.8.0, 70 kB at 1.9.0)
const MAX_UNPACKED_BYTES = 240_000;  // the files once installed (173 kB at 1.4.0, 203 kB at 1.8.0, 224 kB at 1.9.0)

// What `npm publish` would upload, without writing a file.
const [packed] = JSON.parse(execSync('npm pack --dry-run --json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

test('runtime dependencies stay at the MCP SDK and Express', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@modelcontextprotocol/sdk', 'express'],
    'A new runtime dependency needs a strong reason: explain it in the pull request and update this list.');
  assert.equal(pkg.optionalDependencies, undefined);
});

// eval calls the Anthropic API through its SDK. It is an optional peer: npm doesn't install it, so
// everyone who never runs eval still gets two dependencies. cli.js loads it only inside eval.
test('the only peer dependencies are the Anthropic SDK and gpt-tokenizer, and both are optional', () => {
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), ['@anthropic-ai/sdk', 'gpt-tokenizer']);
  const cli = readFileSync(path.join(root, 'cli.js'), 'utf8');
  for (const name of ['@anthropic-ai/sdk', 'gpt-tokenizer']) {
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name}: without optional, npm 7+ installs peers automatically`);
    assert.doesNotMatch(cli, new RegExp(`^import .*${name.replace(/[/.]/g, '\\$&')}`, 'm'), `${name}: a static import would break every command for users without it`);
  }
  const lint = readFileSync(path.join(root, 'public', 'lint.js'), 'utf8');
  assert.doesNotMatch(lint, /gpt-tokenizer/, 'lint.js also runs in the browser, so the tokenizer is passed in, not imported');
});

test('installing runs no scripts', () => {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(pkg.scripts?.[hook], undefined, `"${hook}" would run on every user's machine at install time`);
  }
});

test('the published package stays within its size budget', () => {
  const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
  assert.ok(packed.size <= MAX_TARBALL_BYTES, `tarball is ${kb(packed.size)}, budget is ${kb(MAX_TARBALL_BYTES)}`);
  assert.ok(packed.unpackedSize <= MAX_UNPACKED_BYTES, `unpacked size is ${kb(packed.unpackedSize)}, budget is ${kb(MAX_UNPACKED_BYTES)}`);
});

test('only the app is published: no tests, docs images or local files', () => {
  const allowed = /^(LICENSE|README\.md|package\.json|cli\.js|server\.js|public\/[\w.-]+\.(js|css|html))$/;
  const unexpected = packed.files.map((f) => f.path).filter((p) => !allowed.test(p));
  assert.deepEqual(unexpected, []);
});

test('the page loads nothing from other hosts', () => {
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const loaded = [...html.matchAll(/<(?:script|link|img|iframe|audio|video|source)\b[^>]*?\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(loaded.length > 0);
  assert.deepEqual(loaded.filter((url) => /^(?:[a-z]+:)?\/\//i.test(url)), [], 'scripts, styles and images must be local files');
  const css = readFileSync(path.join(root, 'public/style.css'), 'utf8');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?(?:https?:)?\/\//i, 'style.css must not load remote fonts or styles');
});
