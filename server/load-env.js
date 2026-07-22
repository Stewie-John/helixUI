// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

try {
  const envPath = path.join(__dirname, '../.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && process.env[key] === undefined) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.warn('Could not read .env:', error.message);
  }
}

const cloudCliDataDir = process.env.CLOUDCLI_DATA_DIR || path.join(os.homedir(), '.cloudcli');
if (!process.env.CLOUDCLI_DATA_DIR) process.env.CLOUDCLI_DATA_DIR = cloudCliDataDir;
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = path.join(cloudCliDataDir, 'auth.db');

// 从 ~/.claude/.session_key 加载密钥，避免明文写在 .env 里
if (!process.env.CLAUDE_SESSION_KEY) {
  try {
    const keyPath = path.join(os.homedir(), '.claude', '.session_key');
    process.env.CLAUDE_SESSION_KEY = fs.readFileSync(keyPath, 'utf8').trim();
  } catch (e) {
    // 文件不存在时忽略
  }
}
