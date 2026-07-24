#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} exited with status ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

const releaseArgs = process.argv.slice(2);
const isDryRun = releaseArgs.includes('--dry-run') || releaseArgs.includes('-d');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutableReleaseFiles = ['package.json', 'package-lock.json', 'CHANGELOG.md'];
const snapshots = isDryRun
  ? new Map(mutableReleaseFiles.map((file) => {
      const absolutePath = path.join(projectRoot, file);
      return [absolutePath, fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath) : null];
    }))
  : new Map();

if (isDryRun) {
  releaseArgs.push(
    '--ci',
    '--git.push=false',
    '--git.requireUpstream=false',
    '--git.requireCleanWorkingDir=false',
    '--npm.publish=false',
    '--github.release=false',
  );
}

try {
  run('npx', ['release-it', ...releaseArgs]);
} catch (error) {
  process.exitCode = error.exitCode || 1;
} finally {
  for (const [absolutePath, content] of snapshots) {
    if (content === null) fs.rmSync(absolutePath, { force: true });
    else fs.writeFileSync(absolutePath, content);
  }
}
