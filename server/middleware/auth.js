import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { userDb } from '../database/db.js';
import { IS_PLATFORM } from '../constants/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.CLOUDCLI_DATA_DIR || path.join(os.homedir(), '.cloudcli');
const GENERATED_JWT_SECRET_PATH = path.join(DATA_ROOT, '.jwt-secret');

const readOrCreateGeneratedJwtSecret = () => {
  try {
    fs.mkdirSync(path.dirname(GENERATED_JWT_SECRET_PATH), { recursive: true });

    if (fs.existsSync(GENERATED_JWT_SECRET_PATH)) {
      const existingSecret = fs.readFileSync(GENERATED_JWT_SECRET_PATH, 'utf8').trim();
      if (existingSecret.length >= 32) {
        return existingSecret;
      }
    }

    const generatedSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(GENERATED_JWT_SECRET_PATH, `${generatedSecret}\n`, { mode: 0o600 });
    return generatedSecret;
  } catch (error) {
    const generatedSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      `[WARN] JWT_SECRET is not set and ${GENERATED_JWT_SECRET_PATH} could not be used (${error.message}). ` +
      'Using an in-memory secret; users will need to log in again after restart.'
    );
    return generatedSecret;
  }
};

const resolveJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  const generatedSecret = readOrCreateGeneratedJwtSecret();

  if (!IS_PLATFORM) {
    console.warn(
      `[WARN] JWT_SECRET is not set. Generated a local secret at ${GENERATED_JWT_SECRET_PATH}. ` +
      'Set JWT_SECRET explicitly for production, multi-instance, or ephemeral deployments.'
    );
  }

  return generatedSecret;
};

const JWT_SECRET = resolveJwtSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const sendInvalidAuthToken = (res, error) => {
  res.setHeader('X-Auth-Token-Invalid', '1');
  return res.status(401).json({ error, code: 'AUTH_TOKEN_INVALID' });
};

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return sendInvalidAuthToken(res, 'Access denied. No token provided.');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return sendInvalidAuthToken(res, 'Invalid token. User not found.');
    }
    if (Number(decoded.tokenVersion ?? 0) !== Number(user.token_version ?? 0)) {
      return sendInvalidAuthToken(res, 'Session expired. Please sign in again.');
    }

    req.user = user;
    if (user.must_change_password) {
      const allowedPaths = new Set([
        '/api/auth/user',
        '/api/auth/logout',
        '/api/auth/change-password',
      ]);
      if (!allowedPaths.has(req.originalUrl.split('?')[0])) {
        return res.status(428).json({
          error: 'Password change required before using this account.',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
      }
    }
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return sendInvalidAuthToken(res, 'Invalid token');
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { 
      userId: user.id, 
      username: user.username,
      tokenVersion: Number(user.token_version ?? 0),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = userDb.getUserById(decoded.userId);
    if (!user || user.must_change_password || Number(decoded.tokenVersion ?? 0) !== Number(user.token_version ?? 0)) {
      return null;
    }
    return {
      userId: user.id,
      username: user.username,
      tokenVersion: Number(user.token_version ?? 0),
    };
  } catch (error) {
    console.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  sendInvalidAuthToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};
