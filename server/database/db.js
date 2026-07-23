import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { estimateCodexCredits } from '../codex-usage-pricing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = path.join(__dirname, '../..');
const DATA_ROOT = process.env.CLOUDCLI_DATA_DIR || path.join(os.homedir(), '.cloudcli');

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// Use DATABASE_PATH environment variable if set, otherwise use default location
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_ROOT, 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');
const CREDENTIAL_ENCRYPTION_PREFIX = 'enc:v1:';
const API_KEY_HASH_PREFIX = 'hash:v1:';
const CREDENTIAL_KEY_PATH = process.env.CREDENTIALS_KEY_PATH || path.join(DATA_ROOT, '.credential-key');

// Runtime state must live outside the source/package directory so upgrades are
// atomic and global npm installations do not need write access to package files.
const dbDir = path.dirname(DB_PATH);
try {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    console.log(`Created database directory: ${dbDir}`);
  }
} catch (error) {
  console.error(`Failed to create database directory ${dbDir}:`, error.message);
  throw error;
}

// As part of 1.19.2 we are introducing a new location for auth.db. The below handles exisitng moving legacy database from install directory to new location
const LEGACY_DB_PATH = path.join(__dirname, 'auth.db');
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  try {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    console.log(`[MIGRATION] Copied database from ${LEGACY_DB_PATH} to ${DB_PATH}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix)) {
        fs.copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
      }
    }
  } catch (err) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

// Create database connection
const db = new Database(DB_PATH);

let credentialEncryptionKey = null;

function resolveCredentialEncryptionKey() {
  if (credentialEncryptionKey) return credentialEncryptionKey;

  if (process.env.CREDENTIALS_ENCRYPTION_KEY) {
    const rawKey = process.env.CREDENTIALS_ENCRYPTION_KEY.trim();
    credentialEncryptionKey = /^[a-f0-9]{64}$/i.test(rawKey)
      ? Buffer.from(rawKey, 'hex')
      : crypto.createHash('sha256').update(rawKey).digest();
    return credentialEncryptionKey;
  }

  try {
    fs.mkdirSync(path.dirname(CREDENTIAL_KEY_PATH), { recursive: true });
    if (fs.existsSync(CREDENTIAL_KEY_PATH)) {
      const existingKey = fs.readFileSync(CREDENTIAL_KEY_PATH, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(existingKey)) {
        credentialEncryptionKey = Buffer.from(existingKey, 'hex');
        return credentialEncryptionKey;
      }
    }

    const generatedKey = crypto.randomBytes(32);
    fs.writeFileSync(CREDENTIAL_KEY_PATH, `${generatedKey.toString('hex')}\n`, { mode: 0o600 });
    credentialEncryptionKey = generatedKey;
    console.warn(`[WARN] CREDENTIALS_ENCRYPTION_KEY is not set. Generated a local key at ${CREDENTIAL_KEY_PATH}.`);
    return credentialEncryptionKey;
  } catch (error) {
    console.warn(`[WARN] Could not use credential key file ${CREDENTIAL_KEY_PATH}: ${error.message}`);
    credentialEncryptionKey = crypto.randomBytes(32);
    console.warn('[WARN] Using an in-memory credential key; stored credentials may need to be re-entered after restart.');
    return credentialEncryptionKey;
  }
}

function isEncryptedCredentialValue(value) {
  return typeof value === 'string' && value.startsWith(CREDENTIAL_ENCRYPTION_PREFIX);
}

function encryptCredentialValue(value) {
  if (isEncryptedCredentialValue(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', resolveCredentialEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CREDENTIAL_ENCRYPTION_PREFIX.slice(0, -1),
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64')
  ].join(':');
}

function decryptCredentialValue(value) {
  if (!value) return value;
  if (!isEncryptedCredentialValue(value)) return value;

  const parts = value.split(':');
  if (parts.length !== 5) {
    throw new Error('Invalid encrypted credential format');
  }

  const [, , ivBase64, tagBase64, encryptedBase64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    resolveCredentialEncryptionKey(),
    Buffer.from(ivBase64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function migrateCredentialsEncryption() {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_credentials'"
  ).get();
  if (!tableExists) return;

  const rows = db.prepare('SELECT id, credential_value FROM user_credentials').all();
  const update = db.prepare('UPDATE user_credentials SET credential_value = ? WHERE id = ?');
  let migrated = 0;

  const tx = db.transaction((items) => {
    for (const row of items) {
      if (!row.credential_value || isEncryptedCredentialValue(row.credential_value)) continue;
      update.run(encryptCredentialValue(row.credential_value), row.id);
      migrated++;
    }
  });

  tx(rows);
  if (migrated > 0) {
    console.log(`[MIGRATION] Encrypted ${migrated} stored credential(s)`);
  }
}

function hashApiKey(apiKey) {
  if (typeof apiKey === 'string' && apiKey.startsWith(API_KEY_HASH_PREFIX)) return apiKey;
  return `${API_KEY_HASH_PREFIX}${crypto.createHash('sha256').update(String(apiKey)).digest('hex')}`;
}

// Show app installation path prominently
const appInstallPath = APP_ROOT;
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

const runMigrations = () => {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    if (!columnNames.includes('avatar_url')) {
      console.log('Running migration: Adding avatar_url column');
      db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
    }

    if (!columnNames.includes('token_version')) {
      console.log('Running migration: Adding token_version column');
      db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnNames.includes('must_change_password')) {
      console.log('Running migration: Adding must_change_password column');
      db.exec('ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT 0');
    }

    // 多账号共享数据时记录"哪个账号提交了哪条消息"，渲染时按归属显示对应头像
    db.exec(`CREATE TABLE IF NOT EXISTS message_attributions (
      session_id TEXT NOT NULL,
      message_ts INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, message_ts),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_message_attributions_session ON message_attributions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_message_attributions_user ON message_attributions(user_id)');

    // Per-account daily input totals. Each short browser input batch has an
    // idempotency key, so request retries cannot count the same characters twice.
    db.exec(`CREATE TABLE IF NOT EXISTS daily_input_events (
      user_id INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      input_day TEXT NOT NULL,
      char_count INTEGER NOT NULL CHECK(char_count >= 0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, event_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_daily_input_user_day ON daily_input_events(user_id, input_day)');

    // Per-account model output usage. The event key is derived from the
    // originating browser command, so terminal-event replays remain idempotent.
    db.exec(`CREATE TABLE IF NOT EXISTS model_output_events (
      user_id INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      output_day TEXT NOT NULL,
      input_token_count INTEGER NOT NULL DEFAULT 0 CHECK(input_token_count >= 0),
      cached_input_token_count INTEGER NOT NULL DEFAULT 0 CHECK(cached_input_token_count >= 0),
      token_count INTEGER NOT NULL CHECK(token_count >= 0),
      provider TEXT,
      model TEXT,
      session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, event_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    const modelUsageColumns = db.prepare('PRAGMA table_info(model_output_events)').all().map((column) => column.name);
    if (!modelUsageColumns.includes('input_token_count')) {
      console.log('Running migration: Adding model input token column');
      db.exec('ALTER TABLE model_output_events ADD COLUMN input_token_count INTEGER NOT NULL DEFAULT 0 CHECK(input_token_count >= 0)');
    }
    if (!modelUsageColumns.includes('cached_input_token_count')) {
      console.log('Running migration: Adding cached model input token column');
      db.exec('ALTER TABLE model_output_events ADD COLUMN cached_input_token_count INTEGER NOT NULL DEFAULT 0 CHECK(cached_input_token_count >= 0)');
    }
    if (!modelUsageColumns.includes('model')) {
      console.log('Running migration: Adding model identity column');
      db.exec('ALTER TABLE model_output_events ADD COLUMN model TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_model_output_user_day ON model_output_events(user_id, output_day)');

    // Codex itself keeps only one current goal per thread. Preserve the latest
    // snapshot of every goal so completed/replaced/cleared goals remain visible
    // from the conversation that created them.
    db.exec(`CREATE TABLE IF NOT EXISTS codex_goal_history (
      session_id TEXT NOT NULL,
      runtime_thread_id TEXT,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      archived_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, goal_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_codex_goal_history_session ON codex_goal_history(session_id, created_at_ms DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_codex_goal_history_runtime ON codex_goal_history(runtime_thread_id)');

    // Create session_names table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS session_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      custom_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, provider)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider)');

    // Codex app-server can stream a completed turn before its rollout JSONL is
    // flushed. Keep a small durable transcript journal so a browser refresh
    // never drops a turn that the UI has already shown.
    db.exec(`CREATE TABLE IF NOT EXISTS codex_transcript_events (
      session_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, event_key)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_codex_transcript_events_session ON codex_transcript_events(session_id, event_timestamp)');

    // A logical sidebar session can outlive its original Codex rollout (for
    // example after a broken compaction). Keep its replacement root thread
    // stable across server restarts without changing the browser-facing id.
    db.exec(`CREATE TABLE IF NOT EXISTS codex_runtime_aliases (
      logical_session_id TEXT PRIMARY KEY,
      runtime_thread_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 迁移：旧版把自定义会话名存在遗留表 sessions.custom_name，新版改读 session_names。
    // 历史安装升级后名字会"全部丢失、回退到首句 summary"。这里把遗留名补迁过来（幂等，
    // INSERT OR IGNORE 不覆盖任何已通过新路径设置的名字）。
    const legacySessionsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get();
    if (legacySessionsTable) {
      const migrated = db
        .prepare(
          `INSERT OR IGNORE INTO session_names (session_id, provider, custom_name, created_at, updated_at)
           SELECT session_id, provider, custom_name, created_at, updated_at
           FROM sessions
           WHERE custom_name IS NOT NULL AND trim(custom_name) <> ''`,
        )
        .run();
      if (migrated.changes > 0) {
        console.log(`Running migration: restored ${migrated.changes} custom session name(s) from legacy sessions table`);
      }
    }

    // 会话子文件夹（多层嵌套）：仅元数据，不动 ~/.claude/projects 下的 .jsonl 文件
    // parent_id NULL = 顶层文件夹；删除父文件夹时通过 ON DELETE SET NULL 让子文件夹"升根"
    db.exec(`CREATE TABLE IF NOT EXISTS session_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT NOT NULL,
      parent_id INTEGER,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES session_folders(id) ON DELETE SET NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_folders_project ON session_folders(project_name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_folders_parent ON session_folders(parent_id)');

    // 会话归属到文件夹的映射（一个 session 最多在一个文件夹）
    // 删除文件夹 → CASCADE 删除映射 → session 回到根目录（不会删 .jsonl）
    db.exec(`CREATE TABLE IF NOT EXISTS session_folder_membership (
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      project_name TEXT NOT NULL,
      folder_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, provider),
      FOREIGN KEY (folder_id) REFERENCES session_folders(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sfm_folder ON session_folder_membership(folder_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sfm_project ON session_folder_membership(project_name)');

    // 用户偏好设置表（跨设备持久化，如默认权限模式）
    db.exec(`CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pref_key TEXT NOT NULL,
      pref_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, pref_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_preferences_lookup ON user_preferences(user_id, pref_key)');

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

// Initialize database with schema
const initializeDatabase = async () => {
  try {
    const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
    db.exec(initSQL);
    console.log('Database initialized successfully');
    runMigrations();
    migrateCredentialsEncryption();
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

// User database operations
const userDb = {
  // Check if any users exist
  hasUsers: () => {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
      return row.count > 0;
    } catch (err) {
      throw err;
    }
  },

  // Create a new user
  createUser: (username, passwordHash, mustChangePassword = false) => {
    try {
      const stmt = db.prepare(`
        INSERT INTO users (username, password_hash, must_change_password, has_completed_onboarding)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(
        username,
        passwordHash,
        mustChangePassword ? 1 : 0,
        mustChangePassword ? 1 : 0,
      );
      return { id: result.lastInsertRowid, username, must_change_password: mustChangePassword ? 1 : 0 };
    } catch (err) {
      throw err;
    }
  },

  // Atomically claim a fresh installation. Multiple setup requests can finish
  // password hashing at the same time; only one may create the first admin.
  createFirstUser: (username, passwordHash) => {
    const create = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
      if (existing) return null;
      const result = db.prepare(`
        INSERT INTO users (username, password_hash, must_change_password, has_completed_onboarding)
        VALUES (?, ?, 0, 0)
      `).run(username, passwordHash);
      return { id: result.lastInsertRowid, username, must_change_password: 0 };
    });
    return create.immediate();
  },

  // Get user by username
  getUserByUsername: (username) => {
    try {
      const row = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
      return row;
    } catch (err) {
      throw err;
    }
  },

  // Update last login time (non-fatal — logged but not thrown)
  updateLastLogin: (userId) => {
    try {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    } catch (err) {
      console.warn('Failed to update last login:', err.message);
    }
  },

  // Get user by ID
  getUserById: (userId) => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login, avatar_url, token_version, must_change_password FROM users WHERE id = ? AND is_active = 1').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  getFirstUser: () => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login, avatar_url, token_version, must_change_password FROM users WHERE is_active = 1 LIMIT 1').get();
      return row;
    } catch (err) {
      throw err;
    }
  },

  // 列出所有活跃用户（用于头像批量查询时的兜底，前端按 user_id → avatar_url 索引）
  listActiveUsers: () => {
    try {
      return db.prepare('SELECT id, username, avatar_url FROM users WHERE is_active = 1').all();
    } catch (err) {
      throw err;
    }
  },

  updatePasswordAndRevokeTokens: (userId, passwordHash) => {
    const update = db.prepare(`
      UPDATE users
      SET password_hash = ?, token_version = token_version + 1, must_change_password = 0
      WHERE id = ? AND is_active = 1
    `).run(passwordHash, userId);
    if (update.changes !== 1) return null;
    return userDb.getUserById(userId);
  },

  revokeOtherSessions: (userId) => {
    const update = db.prepare(`
      UPDATE users
      SET token_version = token_version + 1
      WHERE id = ? AND is_active = 1
    `).run(userId);
    if (update.changes !== 1) return null;
    return userDb.getUserById(userId);
  },

  updateAvatar: (userId, avatarUrl) => {
    try {
      db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, userId);
    } catch (err) {
      throw err;
    }
  },

  updateGitConfig: (userId, gitName, gitEmail) => {
    try {
      const stmt = db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?');
      stmt.run(gitName, gitEmail, userId);
    } catch (err) {
      throw err;
    }
  },

  getGitConfig: (userId) => {
    try {
      const row = db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  completeOnboarding: (userId) => {
    try {
      const stmt = db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?');
      stmt.run(userId);
    } catch (err) {
      throw err;
    }
  },

  hasCompletedOnboarding: (userId) => {
    try {
      const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId);
      return row?.has_completed_onboarding === 1;
    } catch (err) {
      throw err;
    }
  }
};

// API Keys database operations
const apiKeysDb = {
  // Generate a new API key
  generateApiKey: () => {
    return 'ck_' + crypto.randomBytes(32).toString('hex');
  },

  // Create a new API key
  createApiKey: (userId, keyName) => {
    try {
      const apiKey = apiKeysDb.generateApiKey();
      const stmt = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
      const result = stmt.run(userId, keyName, hashApiKey(apiKey));
      return { id: result.lastInsertRowid, keyName, apiKey };
    } catch (err) {
      throw err;
    }
  },

  // Get all API keys for a user
  getApiKeys: (userId) => {
    try {
      const rows = db.prepare('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Validate API key and get user
  validateApiKey: (apiKey) => {
    try {
      const hashedApiKey = hashApiKey(apiKey);
      const row = db.prepare(`
        SELECT u.id, u.username, ak.id as api_key_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.api_key IN (?, ?) AND ak.is_active = 1 AND u.is_active = 1
      `).get(hashedApiKey, apiKey);

      if (row) {
        // Update last_used timestamp
        db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
        db.prepare('UPDATE api_keys SET api_key = ? WHERE id = ? AND api_key = ?').run(hashedApiKey, row.api_key_id, apiKey);
      }

      return row;
    } catch (err) {
      throw err;
    }
  },

  // Delete an API key
  deleteApiKey: (userId, apiKeyId) => {
    try {
      const stmt = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
      const result = stmt.run(apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle API key active status
  toggleApiKey: (userId, apiKeyId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User credentials database operations (for GitHub tokens, GitLab tokens, etc.)
const credentialsDb = {
  // Create a new credential
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    try {
      const stmt = db.prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)');
      const encryptedValue = encryptCredentialValue(credentialValue);
      const result = stmt.run(userId, credentialName, credentialType, encryptedValue, description);
      return { id: result.lastInsertRowid, credentialName, credentialType };
    } catch (err) {
      throw err;
    }
  },

  // Get all credentials for a user, optionally filtered by type
  getCredentials: (userId, credentialType = null) => {
    try {
      let query = 'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ?';
      const params = [userId];

      if (credentialType) {
        query += ' AND credential_type = ?';
        params.push(credentialType);
      }

      query += ' ORDER BY created_at DESC';

      const rows = db.prepare(query).all(...params);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Get active credential value for a user by type (returns most recent active)
  getActiveCredential: (userId, credentialType) => {
    try {
      const row = db.prepare('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(userId, credentialType);
      return row?.credential_value ? decryptCredentialValue(row.credential_value) : null;
    } catch (err) {
      throw err;
    }
  },

  // Get a single credential with decrypted value
  getCredentialById: (userId, credentialId, credentialType = null) => {
    try {
      let query = 'SELECT * FROM user_credentials WHERE id = ? AND user_id = ? AND is_active = 1';
      const params = [credentialId, userId];
      if (credentialType) {
        query += ' AND credential_type = ?';
        params.push(credentialType);
      }

      const row = db.prepare(query).get(...params);
      if (!row) return null;
      return {
        ...row,
        credential_value: decryptCredentialValue(row.credential_value),
      };
    } catch (err) {
      throw err;
    }
  },

  // Delete a credential
  deleteCredential: (userId, credentialId) => {
    try {
      const stmt = db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?');
      const result = stmt.run(credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle credential active status
  toggleCredential: (userId, credentialId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// Session custom names database operations
const sessionNamesDb = {
  // Set (insert or update) a custom session name
  setName: (sessionId, provider, customName) => {
    db.prepare(`
      INSERT INTO session_names (session_id, provider, custom_name)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, customName);
  },

  // Get a single custom session name
  getName: (sessionId, provider) => {
    const row = db.prepare(
      'SELECT custom_name FROM session_names WHERE session_id = ? AND provider = ?'
    ).get(sessionId, provider);
    return row?.custom_name || null;
  },

  // Batch lookup — returns Map<sessionId, customName>
  getNames: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, custom_name FROM session_names
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  },

  // Delete a custom session name
  deleteName: (sessionId, provider) => {
    return db.prepare(
      'DELETE FROM session_names WHERE session_id = ? AND provider = ?'
    ).run(sessionId, provider).changes > 0;
  },
};

const codexTranscriptDb = {
  record: (sessionId, eventKey, role, content, timestamp = new Date().toISOString()) => {
    if (!sessionId || !eventKey || !content?.trim()) return;
    db.prepare(`
      INSERT INTO codex_transcript_events (session_id, event_key, role, content, event_timestamp)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, event_key) DO UPDATE SET
        content = excluded.content,
        event_timestamp = excluded.event_timestamp
    `).run(sessionId, eventKey, role, content, timestamp);
  },

  getMessages: (sessionId) => db.prepare(`
    SELECT event_key AS id, role, content, event_timestamp AS timestamp
    FROM codex_transcript_events
    WHERE session_id = ?
    ORDER BY event_timestamp ASC, rowid ASC
  `).all(sessionId),
};

const codexRuntimeAliasesDb = {
  get: (logicalSessionId) => db.prepare(`
    SELECT runtime_thread_id AS runtimeThreadId
    FROM codex_runtime_aliases
    WHERE logical_session_id = ?
  `).get(logicalSessionId)?.runtimeThreadId || null,

  getAll: () => new Map(db.prepare(`
    SELECT runtime_thread_id, logical_session_id
    FROM codex_runtime_aliases
  `).all().map((row) => [row.runtime_thread_id, row.logical_session_id])),

  set: (logicalSessionId, runtimeThreadId) => {
    if (!logicalSessionId || !runtimeThreadId) return;
    db.prepare(`
      INSERT INTO codex_runtime_aliases (logical_session_id, runtime_thread_id)
      VALUES (?, ?)
      ON CONFLICT(logical_session_id) DO UPDATE SET
        runtime_thread_id = excluded.runtime_thread_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(logicalSessionId, runtimeThreadId);
  },

  delete: (logicalSessionId) => db.prepare(
    'DELETE FROM codex_runtime_aliases WHERE logical_session_id = ?'
  ).run(logicalSessionId),
};

// Apply custom session names from the database (overrides CLI-generated summaries)
function applyCustomSessionNames(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const customNames = sessionNamesDb.getNames(ids, provider);
    for (const session of sessions) {
      const custom = customNames.get(session.id);
      if (custom) session.summary = custom;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply custom session names for ${provider}:`, error.message);
  }
}

// 用户偏好设置数据库操作（key-value 键值对，跨设备持久化）
const preferencesDb = {
  get: (userId, key) => {
    try {
      const row = db.prepare(
        'SELECT pref_value FROM user_preferences WHERE user_id = ? AND pref_key = ?'
      ).get(userId, key);
      return row?.pref_value ?? null;
    } catch (err) {
      throw err;
    }
  },

  set: (userId, key, value) => {
    try {
      db.prepare(`
        INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, pref_key)
        DO UPDATE SET pref_value = excluded.pref_value, updated_at = CURRENT_TIMESTAMP
      `).run(userId, key, value);
    } catch (err) {
      throw err;
    }
  },

  // 批量读取（返回 { key: value } 对象）
  getAll: (userId) => {
    try {
      const rows = db.prepare(
        'SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?'
      ).all(userId);
      return Object.fromEntries(rows.map(r => [r.pref_key, r.pref_value]));
    } catch (err) {
      throw err;
    }
  },
};

// 消息归属数据库操作（多账号共享数据时记录"哪个账号提交了哪条消息"）
const attributionDb = {
  // 记录一条消息归属（提交时调用）
  set: (sessionId, messageTs, userId) => {
    try {
      db.prepare(`
        INSERT INTO message_attributions (session_id, message_ts, user_id)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id, message_ts) DO UPDATE SET user_id = excluded.user_id
      `).run(sessionId, messageTs, userId);
    } catch (err) {
      console.warn('attributionDb.set failed:', err.message);
    }
  },

  // 取一个会话的全部归属：返回 [{message_ts, user_id}, ...]
  getBySession: (sessionId) => {
    try {
      return db.prepare(
        'SELECT message_ts, user_id FROM message_attributions WHERE session_id = ?'
      ).all(sessionId);
    } catch (err) {
      console.warn('attributionDb.getBySession failed:', err.message);
      return [];
    }
  },

  // 一次性回填：把指定 session 内 ts <= cutoffTs 且没有归属记录的"历史 user 消息"，
  // 归属给某用户（用于初始升级时把改造前的所有 user 提问归到首位账号）。
  // ts 来自 JSONL 解析，调用方需要保证唯一性。
  bulkBackfillForSession: (sessionId, userId, tsList) => {
    if (!tsList?.length) return 0;
    try {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO message_attributions (session_id, message_ts, user_id)
        VALUES (?, ?, ?)
      `);
      const tx = db.transaction((items) => {
        let n = 0;
        for (const ts of items) {
          const result = insert.run(sessionId, ts, userId);
          if (result.changes > 0) n++;
        }
        return n;
      });
      return tx(tsList);
    } catch (err) {
      console.warn('attributionDb.bulkBackfillForSession failed:', err.message);
      return 0;
    }
  },

  // 检查指定 session 是否已经回填过（任何记录存在即视为回填过）
  hasAnyForSession: (sessionId) => {
    try {
      const row = db.prepare(
        'SELECT 1 FROM message_attributions WHERE session_id = ? LIMIT 1'
      ).get(sessionId);
      return !!row;
    } catch {
      return false;
    }
  },
};

const dailyInputDb = {
  record: (userId, eventId, inputDay, charCount) => {
    const normalizedCount = Math.max(0, Math.min(1_000_000, Math.trunc(Number(charCount) || 0)));
    if (!userId || !eventId || !inputDay || normalizedCount === 0) return false;
    try {
      const result = db.prepare(`
        INSERT OR IGNORE INTO daily_input_events (user_id, event_id, input_day, char_count)
        VALUES (?, ?, ?, ?)
      `).run(userId, String(eventId), String(inputDay), normalizedCount);
      return result.changes > 0;
    } catch (err) {
      console.warn('dailyInputDb.record failed:', err.message);
      return false;
    }
  },

  getForDay: (userId, inputDay) => {
    try {
      const row = db.prepare(`
        SELECT COALESCE(SUM(char_count), 0) AS char_count, COUNT(*) AS event_count
        FROM daily_input_events
        WHERE user_id = ? AND input_day = ?
      `).get(userId, inputDay);
      return {
        charCount: Number(row?.char_count || 0),
        eventCount: Number(row?.event_count || 0),
      };
    } catch (err) {
      console.warn('dailyInputDb.getForDay failed:', err.message);
      return { charCount: 0, eventCount: 0 };
    }
  },

  getAllUserTotals: (inputDay) => {
    try {
      return db.prepare(`
        SELECT
          users.id AS user_id,
          users.username AS username,
          COALESCE(SUM(CASE WHEN daily_input_events.input_day = ? THEN daily_input_events.char_count ELSE 0 END), 0) AS today_count,
          COALESCE(SUM(daily_input_events.char_count), 0) AS total_count
        FROM users
        LEFT JOIN daily_input_events ON daily_input_events.user_id = users.id
        WHERE users.is_active = 1
        GROUP BY users.id, users.username
        ORDER BY today_count DESC, total_count DESC, users.username COLLATE NOCASE ASC
      `).all(inputDay).map((row) => ({
        userId: Number(row.user_id),
        username: row.username,
        todayCount: Number(row.today_count || 0),
        totalCount: Number(row.total_count || 0),
      }));
    } catch (err) {
      console.warn('dailyInputDb.getAllUserTotals failed:', err.message);
      return [];
    }
  },

  getUsageOverview: (userId, startDay, endDay) => {
    try {
      const rows = db.prepare(`
        SELECT input_day AS day, SUM(char_count) AS char_count
        FROM daily_input_events
        WHERE user_id = ?
        GROUP BY input_day
        ORDER BY input_day ASC
      `).all(userId).map((row) => ({
        day: String(row.day),
        charCount: Number(row.char_count || 0),
      }));

      const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
      let bestStreak = 0;
      let streakRun = 0;
      let previousDay = null;
      for (const row of rows) {
        const currentDay = dayNumber(row.day);
        streakRun = previousDay !== null && currentDay === previousDay + 1 ? streakRun + 1 : 1;
        bestStreak = Math.max(bestStreak, streakRun);
        previousDay = currentDay;
      }

      const countsByDay = new Map(rows.map((row) => [row.day, row.charCount]));
      let currentStreak = 0;
      for (let cursor = dayNumber(endDay); countsByDay.get(new Date(cursor * 86_400_000).toISOString().slice(0, 10)); cursor -= 1) {
        currentStreak += 1;
      }

      return {
        days: rows.filter((row) => row.day >= startDay && row.day <= endDay),
        summary: {
          lifetimeCount: rows.reduce((sum, row) => sum + row.charCount, 0),
          peakCount: rows.reduce((peak, row) => Math.max(peak, row.charCount), 0),
          activeDays: rows.length,
          currentStreak,
          bestStreak,
        },
      };
    } catch (err) {
      console.warn('dailyInputDb.getUsageOverview failed:', err.message);
      return {
        days: [],
        summary: { lifetimeCount: 0, peakCount: 0, activeDays: 0, currentStreak: 0, bestStreak: 0 },
      };
    }
  },
};

const modelOutputDb = {
  record: (userId, eventId, outputDay, tokenCount, provider = null, sessionId = null, inputTokenCount = 0, cachedInputTokenCount = 0, model = null) => {
    const normalizedOutputCount = Math.max(0, Math.min(1_000_000_000_000, Math.trunc(Number(tokenCount) || 0)));
    const normalizedInputCount = Math.max(0, Math.min(1_000_000_000_000, Math.trunc(Number(inputTokenCount) || 0)));
    const normalizedCachedInputCount = Math.min(normalizedInputCount, Math.max(0, Math.min(1_000_000_000_000, Math.trunc(Number(cachedInputTokenCount) || 0))));
    if (!userId || !eventId || !outputDay || (normalizedInputCount === 0 && normalizedOutputCount === 0)) return false;
    try {
      const result = db.prepare(`
        INSERT INTO model_output_events
          (user_id, event_id, output_day, input_token_count, cached_input_token_count, token_count, provider, session_id, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, event_id) DO UPDATE SET
          input_token_count = MAX(model_output_events.input_token_count, excluded.input_token_count),
          cached_input_token_count = MAX(model_output_events.cached_input_token_count, excluded.cached_input_token_count),
          token_count = MAX(model_output_events.token_count, excluded.token_count),
          provider = COALESCE(excluded.provider, model_output_events.provider),
          session_id = COALESCE(excluded.session_id, model_output_events.session_id)
          , model = COALESCE(excluded.model, model_output_events.model)
        WHERE excluded.input_token_count > model_output_events.input_token_count
           OR excluded.token_count > model_output_events.token_count
           OR excluded.cached_input_token_count > model_output_events.cached_input_token_count
      `).run(
        userId,
        String(eventId),
        String(outputDay),
        normalizedInputCount,
        normalizedCachedInputCount,
        normalizedOutputCount,
        provider ? String(provider) : null,
        sessionId ? String(sessionId) : null,
        model ? String(model) : null,
      );
      return result.changes > 0;
    } catch (err) {
      console.warn('modelOutputDb.record failed:', err.message);
      return false;
    }
  },

  getForDay: (userId, outputDay) => {
    try {
      const row = db.prepare(`
        SELECT
          COALESCE(SUM(input_token_count), 0) AS input_token_count,
          COALESCE(SUM(token_count), 0) AS token_count,
          COUNT(*) AS event_count
        FROM model_output_events
        WHERE user_id = ? AND output_day = ?
      `).get(userId, outputDay);
      return {
        inputTokenCount: Number(row?.input_token_count || 0),
        outputTokenCount: Number(row?.token_count || 0),
        outputEventCount: Number(row?.event_count || 0),
      };
    } catch (err) {
      console.warn('modelOutputDb.getForDay failed:', err.message);
      return { inputTokenCount: 0, outputTokenCount: 0, outputEventCount: 0 };
    }
  },

  getAllUserTotals: (outputDay) => {
    try {
      const rows = db.prepare(`
        SELECT
          users.id AS user_id,
          model_output_events.provider AS provider,
          model_output_events.model AS model,
          COALESCE(SUM(CASE WHEN model_output_events.output_day = ? THEN model_output_events.input_token_count ELSE 0 END), 0) AS today_input_tokens,
          COALESCE(SUM(CASE WHEN model_output_events.output_day = ? THEN model_output_events.cached_input_token_count ELSE 0 END), 0) AS today_cached_input_tokens,
          COALESCE(SUM(model_output_events.input_token_count), 0) AS total_input_tokens,
          COALESCE(SUM(model_output_events.cached_input_token_count), 0) AS total_cached_input_tokens,
          COALESCE(SUM(CASE WHEN model_output_events.output_day = ? THEN model_output_events.token_count ELSE 0 END), 0) AS today_output_tokens,
          COALESCE(SUM(model_output_events.token_count), 0) AS total_output_tokens
        FROM users
        LEFT JOIN model_output_events ON model_output_events.user_id = users.id
        WHERE users.is_active = 1
        GROUP BY users.id, model_output_events.provider, model_output_events.model
      `).all(outputDay, outputDay, outputDay);
      const totals = new Map();
      for (const row of rows) {
        const userId = Number(row.user_id);
        const total = totals.get(userId) || {
          userId, todayInputTokens: 0, todayCachedInputTokens: 0, totalInputTokens: 0,
          totalCachedInputTokens: 0, todayOutputTokens: 0, totalOutputTokens: 0,
          todayEstimatedCredits: 0, totalEstimatedCredits: 0, hasUnknownPricing: false,
        };
        const todayInputTokens = Number(row.today_input_tokens || 0);
        const todayCachedInputTokens = Number(row.today_cached_input_tokens || 0);
        const totalInputTokens = Number(row.total_input_tokens || 0);
        const totalCachedInputTokens = Number(row.total_cached_input_tokens || 0);
        const todayOutputTokens = Number(row.today_output_tokens || 0);
        const totalOutputTokens = Number(row.total_output_tokens || 0);
        total.todayInputTokens += todayInputTokens;
        total.todayCachedInputTokens += todayCachedInputTokens;
        total.totalInputTokens += totalInputTokens;
        total.totalCachedInputTokens += totalCachedInputTokens;
        total.todayOutputTokens += todayOutputTokens;
        total.totalOutputTokens += totalOutputTokens;
        const todayCredits = row.provider === 'codex' ? estimateCodexCredits({ model: row.model, inputTokens: todayInputTokens, cachedInputTokens: todayCachedInputTokens, outputTokens: todayOutputTokens }) : null;
        const allCredits = row.provider === 'codex' ? estimateCodexCredits({ model: row.model, inputTokens: totalInputTokens, cachedInputTokens: totalCachedInputTokens, outputTokens: totalOutputTokens }) : null;
        if ((todayInputTokens > 0 || todayOutputTokens > 0) && todayCredits === null) total.hasUnknownPricing = true;
        total.todayEstimatedCredits += todayCredits || 0;
        total.totalEstimatedCredits += allCredits || 0;
        totals.set(userId, total);
      }
      return [...totals.values()];
    } catch (err) {
      console.warn('modelOutputDb.getAllUserTotals failed:', err.message);
      return [];
    }
  },

  getUsageOverview: (userId, startDay, endDay) => {
    try {
      const rawRows = db.prepare(`
        SELECT
          output_day AS day,
          provider,
          model,
          SUM(input_token_count) AS input_tokens,
          SUM(cached_input_token_count) AS cached_input_tokens,
          SUM(token_count) AS output_tokens
        FROM model_output_events
        WHERE user_id = ?
        GROUP BY output_day, provider, model
        ORDER BY output_day ASC
      `).all(userId);
      const rowsByDay = new Map();
      for (const row of rawRows) {
        const day = String(row.day);
        const current = rowsByDay.get(day) || { day, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCredits: 0, hasUnknownPricing: false };
        const inputTokens = Number(row.input_tokens || 0);
        const cachedInputTokens = Number(row.cached_input_tokens || 0);
        const outputTokens = Number(row.output_tokens || 0);
        current.inputTokens += inputTokens;
        current.cachedInputTokens += cachedInputTokens;
        current.outputTokens += outputTokens;
        const credits = row.provider === 'codex' ? estimateCodexCredits({ model: row.model, inputTokens, cachedInputTokens, outputTokens }) : null;
        if ((inputTokens > 0 || outputTokens > 0) && credits === null) current.hasUnknownPricing = true;
        current.estimatedCredits += credits || 0;
        rowsByDay.set(day, current);
      }
      const allRows = [...rowsByDay.values()].sort((left, right) => left.day.localeCompare(right.day));
      return {
        days: allRows.filter((row) => row.day >= startDay && row.day <= endDay),
        summary: {
          lifetimeOutputTokens: allRows.reduce((sum, row) => sum + row.outputTokens, 0),
          peakOutputTokens: allRows.reduce((peak, row) => Math.max(peak, row.outputTokens), 0),
          outputDays: allRows.length,
          lifetimeInputTokens: allRows.reduce((sum, row) => sum + row.inputTokens, 0),
          peakInputTokens: allRows.reduce((peak, row) => Math.max(peak, row.inputTokens), 0),
          modelInputDays: allRows.filter((row) => row.inputTokens > 0).length,
        },
      };
    } catch (err) {
      console.warn('modelOutputDb.getUsageOverview failed:', err.message);
      return {
        days: [],
        summary: {
          lifetimeOutputTokens: 0,
          peakOutputTokens: 0,
          outputDays: 0,
          lifetimeInputTokens: 0,
          peakInputTokens: 0,
          modelInputDays: 0,
        },
      };
    }
  },
};

// 会话子文件夹（多层嵌套）：仅前端视图层的归类，不影响 ~/.claude/projects 下的会话文件
const foldersDb = {
  // 列出某 project 下的所有文件夹（含嵌套层级），由前端在内存中拼成树
  listByProject: (projectName) => {
    try {
      return db.prepare(
        'SELECT id, project_name, parent_id, name, created_at, updated_at FROM session_folders WHERE project_name = ? ORDER BY created_at ASC'
      ).all(projectName);
    } catch (err) {
      console.warn('foldersDb.listByProject failed:', err.message);
      return [];
    }
  },

  // 列出某 project 下所有 session 的归属（{session_id, provider} → folder_id）
  listMembershipByProject: (projectName) => {
    try {
      return db.prepare(
        'SELECT session_id, provider, folder_id FROM session_folder_membership WHERE project_name = ?'
      ).all(projectName);
    } catch (err) {
      console.warn('foldersDb.listMembershipByProject failed:', err.message);
      return [];
    }
  },

  getById: (folderId) => {
    try {
      return db.prepare(
        'SELECT id, project_name, parent_id, name, created_at, updated_at FROM session_folders WHERE id = ?'
      ).get(folderId);
    } catch {
      return null;
    }
  },

  // 创建文件夹；parent_id 为 null 时是顶层
  create: (projectName, name, parentId = null) => {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('Folder name is required');
    if (parentId != null) {
      const parent = foldersDb.getById(parentId);
      if (!parent || parent.project_name !== projectName) {
        throw new Error('Parent folder does not belong to this project');
      }
    }
    const stmt = db.prepare(
      'INSERT INTO session_folders (project_name, parent_id, name) VALUES (?, ?, ?)'
    );
    const result = stmt.run(projectName, parentId, trimmed);
    return foldersDb.getById(result.lastInsertRowid);
  },

  // 更新名称 / 移动到新的父文件夹（patch 含 name?, parent_id?）
  // 若 parent_id 是该 folder 的后代，会形成环，需要拒绝
  update: (projectName, folderId, patch) => {
    const folder = foldersDb.getById(folderId);
    if (!folder || folder.project_name !== projectName) {
      throw new Error('Folder not found');
    }
    const updates = [];
    const values = [];
    if (typeof patch.name === 'string') {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new Error('Folder name is required');
      updates.push('name = ?');
      values.push(trimmed);
    }
    if ('parent_id' in patch) {
      const newParent = patch.parent_id;
      if (newParent != null) {
        const parent = foldersDb.getById(newParent);
        if (!parent || parent.project_name !== projectName) {
          throw new Error('Parent folder does not belong to this project');
        }
        // 环检测：从 newParent 向上回溯，遇到 folderId 即环
        let cursor = parent;
        while (cursor) {
          if (cursor.id === folderId) {
            throw new Error('Cannot move folder into its own descendant');
          }
          cursor = cursor.parent_id != null ? foldersDb.getById(cursor.parent_id) : null;
        }
      }
      updates.push('parent_id = ?');
      values.push(newParent);
    }
    if (!updates.length) return folder;
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(folderId);
    db.prepare(`UPDATE session_folders SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return foldersDb.getById(folderId);
  },

  // 删除文件夹：CASCADE 自动清空 membership（session 回根目录）；
  // 子文件夹通过 ON DELETE SET NULL 升为根级
  // 返回 { sessionsAffected, childFoldersAffected } 供前端提示
  remove: (projectName, folderId) => {
    const folder = foldersDb.getById(folderId);
    if (!folder || folder.project_name !== projectName) {
      throw new Error('Folder not found');
    }
    const sessionsAffected = db.prepare(
      'SELECT COUNT(*) as c FROM session_folder_membership WHERE folder_id = ?'
    ).get(folderId).c;
    const childFoldersAffected = db.prepare(
      'SELECT COUNT(*) as c FROM session_folders WHERE parent_id = ?'
    ).get(folderId).c;
    db.prepare('DELETE FROM session_folders WHERE id = ?').run(folderId);
    return { sessionsAffected, childFoldersAffected };
  },

  // 计算文件夹内（直接 + 递归子文件夹内）的 session 数 + 子文件夹数，供删除确认弹窗
  countContents: (projectName, folderId) => {
    try {
      const all = foldersDb.listByProject(projectName);
      const childrenByParent = new Map();
      for (const f of all) {
        if (f.parent_id != null) {
          if (!childrenByParent.has(f.parent_id)) childrenByParent.set(f.parent_id, []);
          childrenByParent.get(f.parent_id).push(f);
        }
      }
      const collect = (id, ids) => {
        ids.add(id);
        for (const c of childrenByParent.get(id) || []) collect(c.id, ids);
      };
      const ids = new Set();
      collect(folderId, ids);
      const idList = [...ids];
      if (!idList.length) return { sessions: 0, folders: 0 };
      const placeholders = idList.map(() => '?').join(',');
      const sessions = db.prepare(
        `SELECT COUNT(*) as c FROM session_folder_membership WHERE folder_id IN (${placeholders})`
      ).get(...idList).c;
      return { sessions, folders: ids.size - 1 };
    } catch {
      return { sessions: 0, folders: 0 };
    }
  },

  // 批量删除孤儿归属：传入 [{session_id, provider}]，对应底层 session 文件已不存在。
  // 用于清理 deleteSession 早期版本遗留、或会话被外部删除后残留的 membership 行，
  // 避免文件夹计数虚高（计数来自 membership，而渲染只显示真实存在的 session）。
  deleteMemberships: (projectName, keys) => {
    if (!Array.isArray(keys) || keys.length === 0) return 0;
    try {
      const stmt = db.prepare(
        'DELETE FROM session_folder_membership WHERE project_name = ? AND session_id = ? AND provider = ?'
      );
      const tx = db.transaction((rows) => {
        let removed = 0;
        for (const row of rows) {
          removed += stmt.run(projectName, row.session_id, row.provider).changes;
        }
        return removed;
      });
      return tx(keys);
    } catch (err) {
      console.warn('foldersDb.deleteMemberships failed:', err.message);
      return 0;
    }
  },

  // 把 session 移动到某文件夹（folderId = null 表示移回根目录）
  setSessionFolder: (sessionId, provider, projectName, folderId) => {
    if (folderId != null) {
      const folder = foldersDb.getById(folderId);
      if (!folder || folder.project_name !== projectName) {
        throw new Error('Folder does not belong to this project');
      }
      db.prepare(`
        INSERT INTO session_folder_membership (session_id, provider, project_name, folder_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, provider) DO UPDATE SET folder_id = excluded.folder_id, project_name = excluded.project_name
      `).run(sessionId, provider, projectName, folderId);
    } else {
      db.prepare(
        'DELETE FROM session_folder_membership WHERE session_id = ? AND provider = ?'
      ).run(sessionId, provider);
    }
  },
};

// Backward compatibility - keep old names pointing to new system
const githubTokensDb = {
  createGithubToken: (userId, tokenName, githubToken, description = null) => {
    return credentialsDb.createCredential(userId, tokenName, 'github_token', githubToken, description);
  },
  getGithubTokens: (userId) => {
    return credentialsDb.getCredentials(userId, 'github_token');
  },
  getActiveGithubToken: (userId) => {
    return credentialsDb.getActiveCredential(userId, 'github_token');
  },
  deleteGithubToken: (userId, tokenId) => {
    return credentialsDb.deleteCredential(userId, tokenId);
  },
  toggleGithubToken: (userId, tokenId, isActive) => {
    return credentialsDb.toggleCredential(userId, tokenId, isActive);
  }
};

export {
  db,
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  sessionNamesDb,
  codexTranscriptDb,
  codexRuntimeAliasesDb,
  preferencesDb,
  attributionDb,
  dailyInputDb,
  modelOutputDb,
  foldersDb,
  applyCustomSessionNames,
  githubTokensDb // Backward compatibility
};
