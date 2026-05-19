import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

// Ensure database directory exists if custom path is provided
if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    console.error(`Failed to create database directory ${dbDir}:`, error.message);
    throw error;
  }
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

// Show app installation path prominently
const appInstallPath = path.join(__dirname, '../..');
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
  createUser: (username, passwordHash) => {
    try {
      const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
      const result = stmt.run(username, passwordHash);
      return { id: result.lastInsertRowid, username };
    } catch (err) {
      throw err;
    }
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
      const row = db.prepare('SELECT id, username, created_at, last_login, avatar_url FROM users WHERE id = ? AND is_active = 1').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  getFirstUser: () => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login, avatar_url FROM users WHERE is_active = 1 LIMIT 1').get();
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
      const result = stmt.run(userId, keyName, apiKey);
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
      const row = db.prepare(`
        SELECT u.id, u.username, ak.id as api_key_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1
      `).get(apiKey);

      if (row) {
        // Update last_used timestamp
        db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
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
      const result = stmt.run(userId, credentialName, credentialType, credentialValue, description);
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
      return row?.credential_value || null;
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
  preferencesDb,
  attributionDb,
  foldersDb,
  applyCustomSessionNames,
  githubTokensDb // Backward compatibility
};