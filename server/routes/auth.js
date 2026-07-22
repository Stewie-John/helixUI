import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { userDb } from '../database/db.js';
import { generateToken, authenticateToken, JWT_SECRET } from '../middleware/auth.js';

const router = express.Router();
const AUTH_RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '', 10) || 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '', 10) || 20;
const AUTH_RATE_LIMIT_KEY_CAP = 5000;
const MULTI_USER_ENABLED = process.env.ENABLE_MULTI_USER === 'true';
const authAttempts = new Map();

const pruneAuthAttempts = (now) => {
  for (const [key, value] of authAttempts) {
    if (now > value.resetAt) authAttempts.delete(key);
  }
  while (authAttempts.size >= AUTH_RATE_LIMIT_KEY_CAP) {
    authAttempts.delete(authAttempts.keys().next().value);
  }
};

const authRateLimit = (req, res, next) => {
  const now = Date.now();
  const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().trim() : '';
  const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${username}`;
  if (!authAttempts.has(key) && authAttempts.size >= AUTH_RATE_LIMIT_KEY_CAP) pruneAuthAttempts(now);
  const current = authAttempts.get(key);

  if (!current || now > current.resetAt) {
    authAttempts.set(key, { count: 1, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (current.count >= AUTH_RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((current.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' });
  }

  current.count += 1;
  authAttempts.set(key, current);
  next();
};

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    const hasUsers = await userDb.hasUsers();
    res.json({ 
      needsSetup: !hasUsers,
      isAuthenticated: false, // Will be overridden by frontend if token exists
      multiUserEnabled: MULTI_USER_ENABLED,
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration —— admin-only：仅首位账号 (id=1) 可创建新账号，
// 防止任何能访问到 server URL 的人随意注册占用 Claude API 资源。
// 空库时允许公开注册第一个账号（首装窗口，注册者成为 admin）。
router.post('/register', authRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (username.length < 3 || username.length > 64 || password.length < 10 || password.length > 1024) {
      return res.status(400).json({
        error: 'Username must be 3-64 characters and password must be 10-1024 characters',
      });
    }

    const hasUsers = await userDb.hasUsers();
    const isFirstUser = !hasUsers;

    if (!isFirstUser && !MULTI_USER_ENABLED) {
      return res.status(403).json({
        error: 'Additional accounts are disabled. Set ENABLE_MULTI_USER=true only for a trusted shared deployment.',
      });
    }

    if (!isFirstUser) {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const adminUser = userDb.getUserById(decoded.userId);
      if (!adminUser || Number(decoded.tokenVersion ?? 0) !== Number(adminUser.token_version ?? 0)) {
        return res.status(401).json({ error: 'Session expired. Please sign in again.' });
      }

      // 仅 id=1（首位账号 = admin）可创建新账号
      if (decoded.userId !== 1) {
        return res.status(403).json({ error: 'Only the admin account can create new users' });
      }
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Accounts created by an administrator receive a one-time password and
    // must replace it before any normal API or WebSocket access is allowed.
    const user = userDb.createUser(username, passwordHash, !isFirstUser);

    // 首装：注册即登录（保持改造前行为）；
    // admin 创建他人账号：不签发 token、不影响 admin 当前会话
    if (isFirstUser) {
      const token = generateToken(user);
      userDb.updateLastLogin(user.id);
      return res.json({
        success: true,
        user: { id: user.id, username: user.username, avatar_url: null },
        token,
      });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        avatar_url: null,
        must_change_password: Boolean(user.must_change_password),
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User login
router.post('/login', authRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Generate token
    const token = generateToken(user);
    
    // Update last login
    userDb.updateLastLogin(user.id);
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url ?? null,
        must_change_password: Boolean(user.must_change_password),
      },
      token,
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

// Logout (client-side token removal, but this endpoint can be used for logging)
router.post('/logout', authenticateToken, (req, res) => {
  // In a simple JWT system, logout is mainly client-side
  // This endpoint exists for consistency and potential future logging
  res.json({ success: true, message: 'Logged out successfully' });
});

const closeAccountSockets = (req, userId, reason) => {
  setTimeout(() => {
    const clients = req.app.locals.wss?.clients || [];
    for (const client of clients) {
      if (Number(client.authUser?.userId) !== Number(userId)) continue;
      try { client.close(4001, reason); } catch { /* ignore */ }
    }
  }, 250).unref?.();
};

router.post('/revoke-other-sessions', authenticateToken, (req, res) => {
  try {
    const updatedUser = userDb.revokeOtherSessions(req.user.id);
    if (!updatedUser) return res.status(404).json({ error: 'User not found' });

    const token = generateToken(updatedUser);
    res.json({
      success: true,
      token,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        avatar_url: updatedUser.avatar_url ?? null,
        must_change_password: Boolean(updatedUser.must_change_password),
      },
    });
    closeAccountSockets(req, updatedUser.id, 'Other sessions revoked');
  } catch (error) {
    console.error('Revoke other sessions error:', error);
    res.status(500).json({ error: 'Failed to sign out other devices' });
  }
});

router.post('/change-password', authenticateToken, authRateLimit, async (req, res) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (newPassword.length < 10) {
      return res.status(400).json({ error: 'New password must be at least 10 characters' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    const account = userDb.getUserByUsername(req.user.username);
    if (!account || !(await bcrypt.compare(currentPassword, account.password_hash))) {
      // This is a form-validation failure, not an invalid bearer token. A 401
      // would make authenticatedFetch erase the current browser's valid login.
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updatedUser = userDb.updatePasswordAndRevokeTokens(req.user.id, passwordHash);
    if (!updatedUser) return res.status(404).json({ error: 'User not found' });

    const token = generateToken(updatedUser);
    res.json({
      success: true,
      token,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        avatar_url: updatedUser.avatar_url ?? null,
        must_change_password: false,
      },
    });

    // The response gives this browser its replacement token first. Then close
    // every socket authenticated with the old account version; only this browser
    // can reconnect because all other stored JWTs are now invalid.
    closeAccountSockets(req, updatedUser.id, 'Account credentials changed');
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export default router;
