#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Scan production output too: minification must not hide a private constant that
// was accidentally compiled into the browser bundle.
const ignoredDirectories = new Set(['.git', 'node_modules', 'coverage', 'trash']);
const forbiddenDirectoryPaths = new Set(['.certs', 'backups', 'data', 'logs', 'public/screenshots']);
const forbiddenDirectoryPrefixes = ['.security-test-'];
const forbiddenFileNames = new Set([
  '.env',
  '.jwt-secret',
  '.credential-key',
  'auth.db',
  'database.sqlite',
  'server.key',
  'server.crt',
  'ccui-local-root-ca.crt',
  'ccui-local-root-ca.cer',
]);
const forbiddenExtensions = new Set(['.key', '.pem', '.p12', '.pfx', '.sqlite', '.sqlite3', '.db']);
const textExtensions = new Set([
  '', '.cjs', '.css', '.env', '.example', '.html', '.js', '.json', '.jsx', '.md',
  '.mjs', '.sh', '.sql', '.svg', '.ts', '.tsx', '.txt', '.yaml', '.yml', '.py',
]);
const contentRules = [
  ['private deployment path', /(?:\/mnt\/data\/bks|\/home\/bks)(?:\/|\b)/i],
  ['private deployment address', /\b10\.102\.34\.208\b/],
  ['private project identifier', /(?:^|[^A-Za-z0-9])(?:Aletheia|YKX|LSJ)(?:[^A-Za-z0-9]|$)/i],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub access token', /\bghp_(?!x{20,}\b)[A-Za-z0-9]{20,}\b/],
  ['GitHub fine-grained access token', /\bgithub_pat_(?!x{20,}\b)[A-Za-z0-9_]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['embedded URL credentials', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
];

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (
        forbiddenDirectoryPaths.has(relativePath)
        || forbiddenDirectoryPrefixes.some((prefix) => relativePath.startsWith(prefix))
      ) {
        files.push({ relativePath, violation: 'forbidden runtime/private directory' });
      } else {
        walk(absolutePath, files);
      }
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }
  return files;
}

const violations = [];
const repositoryFiles = walk(root);
for (const file of repositoryFiles) {
  if (file.violation) {
    violations.push(`${file.relativePath}: ${file.violation}`);
    continue;
  }
  const baseName = path.basename(file.relativePath);
  const extension = path.extname(baseName).toLowerCase();
  if (forbiddenFileNames.has(baseName) || forbiddenExtensions.has(extension)) {
    violations.push(`${file.relativePath}: forbidden secret/runtime file`);
    continue;
  }
  if (
    file.relativePath === 'scripts/check-public-release.mjs'
    || file.relativePath === 'scripts/test-package-install.mjs'
  ) continue;
  if (file.relativePath === 'package-lock.json' || !textExtensions.has(extension)) continue;
  const content = fs.readFileSync(file.absolutePath, 'utf8');
  for (const [label, pattern] of contentRules) {
    if (pattern.test(content)) violations.push(`${file.relativePath}: ${label}`);
  }
}

if (fs.existsSync(path.join(root, '.git'))) {
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
    const trackedPaths = new Set(tracked.split('\n').filter(Boolean));
    for (const trackedPath of trackedPaths) {
      const parts = trackedPath.split('/');
      const baseName = parts.at(-1);
      if (forbiddenDirectoryPaths.has(parts.slice(0, -1).join('/'))
          || forbiddenFileNames.has(baseName)
          || forbiddenExtensions.has(path.extname(baseName).toLowerCase())) {
        violations.push(`${trackedPath}: forbidden path is tracked by Git`);
      }
    }
    for (const file of repositoryFiles) {
      if (
        file.absolutePath
        && file.relativePath.startsWith('src/')
        && !trackedPaths.has(file.relativePath)
      ) {
        violations.push(`${file.relativePath}: source file is not tracked by Git`);
      }
    }
  } catch (error) {
    violations.push(`Git tracked-file scan failed: ${error.message}`);
  }
}

if (violations.length) {
  console.error('Public release privacy check failed:\n');
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Public release privacy check passed.');
