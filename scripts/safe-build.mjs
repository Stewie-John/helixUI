#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(projectRoot, 'dist');

if (fs.existsSync(outputPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveRoot = path.join(projectRoot, 'trash', 'builds', stamp);
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.renameSync(outputPath, path.join(archiveRoot, 'dist'));
}

const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const result = spawnSync(process.execPath, [viteCli, 'build'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
