#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

await import('../server/load-env.js');
const originalLog = console.log;
console.log = () => {};
const [{ initializeDatabase, userDb }, { generateToken }] = await Promise.all([
  import('../server/database/db.js'),
  import('../server/middleware/auth.js'),
]);
await initializeDatabase();
const user = userDb.getFirstUser();
console.log = originalLog;

if (!user) throw new Error('No local user is available for the idle check');
const token = generateToken(user);
const securePort = Number(process.env.HTTPS_PORT || 3443);

const getActiveTurnCount = () => new Promise((resolve, reject) => {
  const socket = new WebSocket(`wss://127.0.0.1:${securePort}/ws?token=${encodeURIComponent(token)}`, {
    rejectUnauthorized: false,
  });
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error('Active-turn check timed out'));
  }, 5000);
  socket.once('open', () => socket.send(JSON.stringify({ type: 'get-active-sessions' })));
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== 'active-sessions') return;
    clearTimeout(timeout);
    const sessions = message.sessions || {};
    const count = Object.values(sessions).reduce(
      (sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0),
      0,
    );
    socket.close();
    resolve(count);
  });
  socket.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

let consecutiveIdleChecks = 0;
while (consecutiveIdleChecks < 3) {
  try {
    const activeTurnCount = await getActiveTurnCount();
    consecutiveIdleChecks = activeTurnCount === 0 ? consecutiveIdleChecks + 1 : 0;
    originalLog(`[safe-restart] active turns: ${activeTurnCount}; idle checks: ${consecutiveIdleChecks}/3`);
  } catch (error) {
    consecutiveIdleChecks = 0;
    console.error(`[safe-restart] ${error.message}`);
  }
  if (consecutiveIdleChecks < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
}

if (process.argv.includes('--reload-clients')) {
  const stopResult = spawnSync('systemctl', ['--user', 'stop', 'ccui.service'], { stdio: 'inherit' });
  if (stopResult.status !== 0) process.exit(stopResult.status ?? 1);
  await new Promise((resolve) => setTimeout(resolve, 12000));
  const startResult = spawnSync('systemctl', ['--user', 'start', 'ccui.service'], { stdio: 'inherit' });
  process.exit(startResult.status ?? 1);
}

const restartResult = spawnSync('systemctl', ['--user', 'restart', 'ccui.service'], { stdio: 'inherit' });
process.exit(restartResult.status ?? 1);
