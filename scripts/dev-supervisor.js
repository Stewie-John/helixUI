import { spawn } from 'child_process';

const RESTART_DELAY_MS = 1500;

const children = new Map();
let shuttingDown = false;

const tasks = [
  { name: 'server', command: 'npm', args: ['run', 'server'] },
  { name: 'client', command: 'npm', args: ['run', 'client'] },
];

function startTask(task) {
  if (shuttingDown) return;

  const child = spawn(task.command, task.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  children.set(task.name, child);
  console.log(`[dev-supervisor] ${task.name} started pid=${child.pid}`);

  child.on('exit', (code, signal) => {
    children.delete(task.name);
    if (shuttingDown) return;

    const reason = signal || `code ${code}`;
    console.warn(`[dev-supervisor] ${task.name} exited (${reason}); restarting in ${RESTART_DELAY_MS}ms`);
    setTimeout(() => startTask(task), RESTART_DELAY_MS);
  });

  child.on('error', (error) => {
    console.error(`[dev-supervisor] ${task.name} failed to start:`, error.message);
  });
}

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children.values()) {
    if (!child.killed) child.kill(signal);
  }
}

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
process.on('exit', () => stopAll('SIGTERM'));

for (const task of tasks) startTask(task);
