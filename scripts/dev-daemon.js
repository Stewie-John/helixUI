import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const action = process.argv[2] || 'status';
const root = process.cwd();
const logsDir = path.join(root, 'logs');
const pidFile = path.join(logsDir, 'dev-supervisor.pid');
const logFile = path.join(logsDir, 'dev-supervisor.log');
const supervisorScript = path.join(root, 'scripts', 'dev-supervisor.js');

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function start() {
  fs.mkdirSync(logsDir, { recursive: true });
  const existingPid = readPid();
  if (existingPid && isAlive(existingPid)) {
    console.log(`dev supervisor already running pid=${existingPid}`);
    return;
  }

  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [supervisorScript], {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: ['ignore', out, out],
  });

  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  console.log(`dev supervisor started pid=${child.pid}`);
  console.log(`logs: ${logFile}`);
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log('dev supervisor is not running');
    return;
  }

  try {
    if (process.platform === 'win32') {
      process.kill(pid, 'SIGTERM');
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }
  fs.rmSync(pidFile, { force: true });
  console.log(`dev supervisor stopped pid=${pid}`);
}

function status() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    console.log(`dev supervisor running pid=${pid}`);
    console.log(`logs: ${logFile}`);
  } else {
    console.log('dev supervisor is not running');
  }
}

if (action === 'start') start();
else if (action === 'stop') stop();
else if (action === 'status') status();
else {
  console.error(`Unknown action: ${action}`);
  process.exit(1);
}
