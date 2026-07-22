#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import https from 'node:https';

await import('../server/load-env.js');
const securePort = Number(process.env.HTTPS_PORT || 3443);

const getActiveTurnCount = () => new Promise((resolve, reject) => {
  const request = https.get({
    hostname: '127.0.0.1',
    port: securePort,
    path: '/health',
    rejectUnauthorized: false,
    timeout: 5000,
  }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try {
        const health = JSON.parse(body);
        if (!Number.isFinite(health.activeTurnCount)) {
          throw new Error('Health response omitted activeTurnCount');
        }
        resolve(health.activeTurnCount);
      } catch (error) {
        reject(error);
      }
    });
  });
  request.on('timeout', () => request.destroy(new Error('Active-turn check timed out')));
  request.on('error', reject);
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
