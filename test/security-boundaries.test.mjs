import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const testArchiveRoot = path.join(process.cwd(), 'trash', 'test-artifacts');
await fs.mkdir(testArchiveRoot, { recursive: true });
const temporaryRoot = await fs.mkdtemp(path.join(testArchiveRoot, 'security-'));
const workspaceRoot = path.join(temporaryRoot, 'workspaces');
const outsideRoot = path.join(temporaryRoot, 'outside');
await fs.mkdir(workspaceRoot, { recursive: true });
await fs.mkdir(outsideRoot, { recursive: true });

process.env.WORKSPACES_ROOT = workspaceRoot;
process.env.CLOUDCLI_DATA_DIR = path.join(temporaryRoot, 'data');
process.env.DATABASE_PATH = path.join(temporaryRoot, 'data', 'auth.db');

const {
  validateWorkspacePath,
  WORKSPACES_ROOT,
  assertSupportedRemoteUrl,
} = await import('../server/routes/projects.js');
const { resolvePathWithinRoot, isSafePathSegment } = await import('../server/utils/path-security.js');
const {
  isAllowedRequestHost,
  isAllowedWebSocketOrigin,
} = await import('../server/utils/request-origin.js');
const { authenticateToken } = await import('../server/middleware/auth.js');

const runAuthentication = async (authorization) => {
  const headers = new Map();
  let statusCode = 200;
  let body = null;
  let nextCalled = false;
  const req = {
    headers: authorization ? { authorization } : {},
    originalUrl: '/api/projects',
  };
  const res = {
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  await authenticateToken(req, res, () => { nextCalled = true; });
  return { headers, statusCode, body, nextCalled };
};

test('workspace operations accept paths inside the configured root', async () => {
  const project = path.join(workspaceRoot, 'project-a');
  await fs.mkdir(project);
  const result = await validateWorkspacePath(project);
  assert.equal(result.valid, true);
  assert.equal(result.resolvedPath, await fs.realpath(project));
  assert.equal(WORKSPACES_ROOT, workspaceRoot);
});

test('workspace operations reject paths outside the configured root', async () => {
  const result = await validateWorkspacePath(outsideRoot);
  assert.equal(result.valid, false);
  assert.match(result.error, /allowed workspace root/i);
});

test('workspace operations reject symlinks escaping the configured root', async () => {
  const link = path.join(workspaceRoot, 'escape-link');
  await fs.symlink(outsideRoot, link);
  const result = await validateWorkspacePath(link);
  assert.equal(result.valid, false);
  assert.match(result.error, /allowed workspace root|symlink target/i);
});

test('file operations reject absolute paths outside their project', async () => {
  const project = path.join(workspaceRoot, 'project-files');
  await fs.mkdir(project);
  await assert.rejects(
    resolvePathWithinRoot(project, outsideRoot),
    (error) => error.code === 'PATH_OUTSIDE_ROOT',
  );
});

test('file operations reject symlink escapes and accept missing descendants', async () => {
  const project = path.join(workspaceRoot, 'project-links');
  await fs.mkdir(project);
  const link = path.join(project, 'outside');
  await fs.symlink(outsideRoot, link);

  await assert.rejects(
    resolvePathWithinRoot(project, path.join(link, 'secret.txt')),
    (error) => error.code === 'PATH_OUTSIDE_ROOT',
  );

  const result = await resolvePathWithinRoot(project, 'new/deep/file.txt');
  assert.equal(result.path, path.join(project, 'new/deep/file.txt'));
});

test('browser WebSockets accept same-origin and reject foreign origins', () => {
  assert.equal(isAllowedWebSocketOrigin({ headers: { host: 'app.example.test', origin: 'https://app.example.test' } }), true);
  assert.equal(isAllowedWebSocketOrigin({ headers: { host: 'app.example.test', origin: 'https://evil.example.test' } }), false);
  assert.equal(isAllowedWebSocketOrigin({ headers: { host: 'app.example.test' } }), false);
});

test('WebSocket origin allowlists support trusted reverse proxies', () => {
  const request = {
    headers: {
      host: '127.0.0.1:3001',
      'x-forwarded-host': 'internal.example.test',
      origin: 'https://public.example.test',
    },
  };
  assert.equal(isAllowedWebSocketOrigin(request, { allowedOrigins: 'https://public.example.test' }), true);
  assert.equal(isAllowedWebSocketOrigin({ headers: {} }, { allowMissingOrigin: true }), true);
});

test('public hostname allowlists reject host-header confusion', () => {
  assert.equal(
    isAllowedRequestHost(
      { headers: { host: 'app.example.test' } },
      'app.example.test',
    ),
    true,
  );
  assert.equal(
    isAllowedRequestHost(
      { headers: { host: '127.0.0.1:3001', 'x-forwarded-host': 'evil.example.test' } },
      'app.example.test',
    ),
    false,
  );
  assert.equal(
    isAllowedRequestHost(
      { headers: { host: 'evil.example.test', 'x-forwarded-host': 'app.example.test' } },
      'app.example.test',
    ),
    false,
  );
  assert.equal(isAllowedRequestHost({ headers: { host: 'anything.test' } }, ''), true);
});

test('project and session identifiers cannot carry a path', () => {
  for (const traversal of ['../../../tmp', '..', '.', 'a/b', 'a\\b', '', 'x\0y', '/etc']) {
    assert.equal(isSafePathSegment(traversal), false, `expected ${JSON.stringify(traversal)} to be rejected`);
  }
  for (const valid of ['-workspace-root-project', 'project.name_1', 'a-b-c']) {
    assert.equal(isSafePathSegment(valid), true, `expected ${JSON.stringify(valid)} to be accepted`);
  }
});

// Express decodes %2F into route params, so `..%2F..%2Ftmp` arrives as a real
// relative path and escapes whatever root the handler joins it onto. The
// handler here stands in for the deletion routes that call fs.rm(recursive).
test('percent-encoded traversal never reaches a route handler', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.param('projectName', (req, res, next, value) => (
    isSafePathSegment(value) ? next() : res.status(400).json({ error: 'Invalid projectName' })
  ));
  app.delete('/api/projects/:projectName', (req, res) => res.json({ reached: req.params.projectName }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const escaped = await fetch(`${origin}/api/projects/..%2F..%2F..%2Ftmp`, { method: 'DELETE' });
    assert.equal(escaped.status, 400);

    const allowed = await fetch(`${origin}/api/projects/-mnt-data`, { method: 'DELETE' });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { reached: '-mnt-data' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// `git clone -- <url>` blocks option injection but not the transport itself:
// `ext::` hands the rest of the string to a shell, and `file://` reads any local
// directory. Both are valid git URLs, so the scheme needs an allowlist.
test('clone remote URLs are restricted to network transports', () => {
  for (const url of [
    'https://github.com/owner/repo.git',
    'http://gitea.internal/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'git://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
  ]) {
    assert.equal(assertSupportedRemoteUrl(url), url, `expected ${url} to be accepted`);
  }

  for (const url of [
    'ext::sh -c "id > /tmp/pwned"',
    'file:///etc',
    '/etc/passwd',
    '../../../etc',
    '',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => assertSupportedRemoteUrl(url), /remote URLs are supported/, `expected ${JSON.stringify(url)} to be rejected`);
  }
});

test('invalid bearer tokens are explicitly marked without conflating normal forbidden responses', async () => {
  const result = await runAuthentication('Bearer invalid.jwt.value');
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.headers.get('x-auth-token-invalid'), '1');
  assert.equal(result.body?.code, 'AUTH_TOKEN_INVALID');
});
