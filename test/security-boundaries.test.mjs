import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';

const temporaryRoot = await fs.mkdtemp(path.join(process.cwd(), '.security-test-'));
const workspaceRoot = path.join(temporaryRoot, 'workspaces');
const outsideRoot = path.join(temporaryRoot, 'outside');
await fs.mkdir(workspaceRoot, { recursive: true });
await fs.mkdir(outsideRoot, { recursive: true });

process.env.WORKSPACES_ROOT = workspaceRoot;
process.env.CLOUDCLI_DATA_DIR = path.join(temporaryRoot, 'data');
process.env.DATABASE_PATH = path.join(temporaryRoot, 'data', 'auth.db');

const { validateWorkspacePath, WORKSPACES_ROOT } = await import('../server/routes/projects.js');
const { resolvePathWithinRoot } = await import('../server/utils/path-security.js');
const { isAllowedWebSocketOrigin } = await import('../server/utils/request-origin.js');

after(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

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
