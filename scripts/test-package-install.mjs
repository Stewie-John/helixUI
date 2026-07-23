#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-ui-package-'));
const consumerRoot = path.join(temporaryRoot, 'consumer');
const homeRoot = path.join(temporaryRoot, 'home');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    encoding: 'utf8',
    env: options.env || process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed\n${output}`);
  }
  return result.stdout.trim();
}

function npm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForHealth(url, child, getOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Installed server exited before becoming healthy\n${getOutput()}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return response.json();
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Installed server did not become healthy\n${getOutput()}`);
}

async function waitForPath(targetPath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(targetPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fs.existsSync(targetPath);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let installedServer;
try {
  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });

  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', temporaryRoot]));
  const manifest = packed[0];
  if (!manifest?.filename || !Array.isArray(manifest.files)) {
    throw new Error('npm pack did not return a valid package manifest');
  }
  if (manifest.size > 25 * 1024 * 1024) {
    throw new Error(`Package is unexpectedly large: ${manifest.size} bytes`);
  }

  const forbiddenPath = /(^|\/)(?:\.env(?:\.|$)|\.certs|auth\.db|data|logs?|sessions?|screenshots?|backups?)(\/|$)|\.(?:db|sqlite3?|pem|p12|pfx|key)$/i;
  const forbiddenFiles = manifest.files.map((file) => file.path).filter((file) => forbiddenPath.test(file));
  if (forbiddenFiles.length) {
    throw new Error(`Private/runtime files were packed: ${forbiddenFiles.join(', ')}`);
  }
  const packagedContentRules = [
    ['private deployment path', /(?:\/mnt\/data\/bks|\/home\/bks)(?:\/|\b)/i],
    ['private deployment address', /\b10\.102\.34\.208\b/],
    ['private project identifier', /(?:^|[^A-Za-z0-9])(?:Aletheia|YKX|LSJ)(?:[^A-Za-z0-9]|$)/i],
    ['private account identifier', /\b(?:Stewie|LGS|YJL|ZJR)\b/],
    ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['GitHub access token', /\bghp_(?!x{20,}\b)[A-Za-z0-9]{20,}\b/],
    ['GitHub fine-grained access token', /\bgithub_pat_(?!x{20,}\b)[A-Za-z0-9_]{20,}\b/],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ];
  const packageTextExtensions = new Set([
    '', '.cjs', '.css', '.html', '.js', '.json', '.mjs', '.md', '.py',
    '.sh', '.sql', '.svg', '.txt', '.yaml', '.yml',
  ]);
  const packagedContentViolations = [];
  for (const file of manifest.files) {
    if (file.path === 'scripts/check-public-release.mjs') continue;
    if (!packageTextExtensions.has(path.extname(file.path).toLowerCase())) continue;
    const sourcePath = path.join(projectRoot, file.path);
    if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size > 20 * 1024 * 1024) continue;
    const content = fs.readFileSync(sourcePath, 'utf8');
    for (const [label, pattern] of packagedContentRules) {
      if (pattern.test(content)) packagedContentViolations.push(`${file.path}: ${label}`);
    }
  }
  if (packagedContentViolations.length) {
    throw new Error(`Private content was packed: ${packagedContentViolations.join(', ')}`);
  }

  fs.writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({ private: true }, null, 2));
  const installEnv = {
    ...process.env,
    HOME: homeRoot,
    NODE_ENV: 'production',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  npm(['install', path.join(temporaryRoot, manifest.filename), '--omit=dev'], {
    cwd: consumerRoot,
    env: installEnv,
  });
  npm(['audit', '--omit=dev', '--audit-level=moderate'], {
    cwd: consumerRoot,
    env: { ...installEnv, npm_config_audit: 'true' },
  });

  const executable = path.join(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'helix-ui.cmd' : 'helix-ui',
  );
  const version = run(executable, ['--version'], { cwd: consumerRoot, env: installEnv });
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI version mismatch: expected ${packageJson.version}, received ${version}`);
  }
  const help = run(executable, ['--help'], { cwd: consumerRoot, env: installEnv });
  if (!help.includes('HelixUI') || help.includes('cloudcli ')) {
    throw new Error('Installed CLI help contains stale branding or is incomplete');
  }

  const dataRoot = path.join(temporaryRoot, 'runtime-data');
  const workspacesRoot = path.join(temporaryRoot, 'workspaces');
  const port = await getOpenPort();
  const serverEnv = {
    ...installEnv,
    CLOUDCLI_DATA_DIR: dataRoot,
    WORKSPACES_ROOT: workspacesRoot,
    HOST: '127.0.0.1',
    HTTPS_ENABLED: 'false',
  };
  for (const name of ['DATABASE_PATH', 'JWT_SECRET', 'CREDENTIALS_ENCRYPTION_KEY']) {
    delete serverEnv[name];
  }
  let serverOutput = '';
  installedServer = spawn(executable, ['start', '--port', String(port)], {
    cwd: consumerRoot,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  installedServer.stdout.on('data', (chunk) => { serverOutput += chunk; });
  installedServer.stderr.on('data', (chunk) => { serverOutput += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl, installedServer, () => serverOutput);
  if (health.status !== 'ok' || health.activeTurnCount !== 0) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }

  const authStatus = await fetch(`${baseUrl}/api/auth/status`).then((response) => response.json());
  if (!authStatus.needsSetup || authStatus.isAuthenticated) {
    throw new Error(`Unexpected first-run auth status: ${JSON.stringify(authStatus)}`);
  }
  const rootResponse = await fetch(baseUrl);
  const contentSecurityPolicy = rootResponse.headers.get('content-security-policy') || '';
  if (
    !contentSecurityPolicy.includes("default-src 'self'") ||
    !contentSecurityPolicy.includes("object-src 'none'") ||
    !contentSecurityPolicy.includes("frame-src 'none'") ||
    !contentSecurityPolicy.includes("script-src 'self'") ||
    /(?:^|;\s*)script-src[^;]*'unsafe-inline'/.test(contentSecurityPolicy)
  ) {
    throw new Error(`Installed server is missing the expected CSP: ${contentSecurityPolicy}`);
  }
  const modelConstantsResponse = await fetch(`${baseUrl}/shared/modelConstants.js`);
  const modelConstantsSource = await modelConstantsResponse.text();
  if (!modelConstantsResponse.ok || !modelConstantsSource.includes('export const CODEX_MODELS')) {
    throw new Error('Installed API documentation cannot load the shared model catalog');
  }
  const protectedRequests = [
    ['GET', '/api/projects'],
    ['GET', '/api/projects/example/folders'],
    ['GET', '/api/user/daily-input'],
    ['GET', '/api/sys-stats'],
    ['GET', '/api/browse?path=.'],
    ['POST', '/api/agent'],
  ];
  for (const [method, requestPath] of protectedRequests) {
    const response = await fetch(`${baseUrl}${requestPath}`, { method });
    if (response.status !== 401) {
      throw new Error(`Unauthenticated ${method} ${requestPath} returned ${response.status}, expected 401`);
    }
  }
  const registrationAttempts = await Promise.all(
    [
      { username: 'release-admin', password: 'temporary-pass-123' },
      { username: 'setup-racer', password: 'temporary-pass-456' },
    ].map(async (credentials) => {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      return { status: response.status, body: await response.json() };
    })
  );
  const successfulRegistrations = registrationAttempts.filter(({ body }) => body.success && body.token);
  const rejectedRegistrations = registrationAttempts.filter(({ status }) => status === 409);
  if (successfulRegistrations.length !== 1 || rejectedRegistrations.length !== 1) {
    throw new Error(`First-run registration was not atomic: ${JSON.stringify(registrationAttempts)}`);
  }
  const registration = successfulRegistrations[0].body;
  if (!registration.success || !registration.token) {
    throw new Error(`First-run registration failed: ${JSON.stringify(registration)}`);
  }
  const projectsResponse = await fetch(`${baseUrl}/api/projects`, {
    headers: { Authorization: `Bearer ${registration.token}` },
  });
  if (!projectsResponse.ok || !Array.isArray(await projectsResponse.json())) {
    throw new Error('Authenticated project listing failed');
  }
  const snapshotTimestamp = 1_700_000_000_000;
  const snapshotSource = path.join(workspacesRoot, 'snapshot.png');
  fs.writeFileSync(snapshotSource, Buffer.from('89504e470d0a1a0a', 'hex'));
  const snapshotResponse = await fetch(
    `${baseUrl}/api/image?path=${encodeURIComponent(snapshotSource)}&snapshot=1&t=${snapshotTimestamp}`,
    { headers: { Authorization: `Bearer ${registration.token}` } },
  );
  if (!snapshotResponse.ok) {
    throw new Error(`Authenticated image snapshot failed with ${snapshotResponse.status}`);
  }
  await snapshotResponse.arrayBuffer();
  const installedPackageRoot = path.join(consumerRoot, 'node_modules', '@stewiejohn', 'helix-ui');
  const paths = {
    database: fs.existsSync(path.join(dataRoot, 'auth.db')),
    projectCache: await waitForPath(path.join(dataRoot, 'projects-cache.json')),
    workspaces: fs.existsSync(workspacesRoot),
    imageSnapshot: fs.existsSync(path.join(dataRoot, 'image-snapshots', String(snapshotTimestamp), 'snapshot.png')),
    unexpectedPackageData: fs.existsSync(path.join(installedPackageRoot, 'data', 'image-snapshots')),
    unexpectedHomeData: fs.existsSync(path.join(homeRoot, '.cloudcli')),
  };
  if (
    !paths.database ||
    !paths.projectCache ||
    !paths.workspaces ||
    !paths.imageSnapshot ||
    paths.unexpectedPackageData ||
    paths.unexpectedHomeData
  ) {
    throw new Error(`Installed runtime path isolation failed: ${JSON.stringify(paths)}`);
  }

  console.log(`Package install check passed (${manifest.entryCount} files, ${manifest.size} bytes).`);
} finally {
  await stopChild(installedServer);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
