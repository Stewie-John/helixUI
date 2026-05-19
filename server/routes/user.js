import express from 'express';
import { userDb } from '../database/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { getSystemGitConfig } from '../utils/gitConfig.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const router = express.Router();

router.get('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let gitConfig = userDb.getGitConfig(userId);

    // If database is empty, try to get from system git config
    if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
      const systemConfig = await getSystemGitConfig();

      // If system has values, save them to database for this user
      if (systemConfig.git_name || systemConfig.git_email) {
        userDb.updateGitConfig(userId, systemConfig.git_name, systemConfig.git_email);
        gitConfig = systemConfig;
        console.log(`Auto-populated git config from system for user ${userId}: ${systemConfig.git_name} <${systemConfig.git_email}>`);
      }
    }

    res.json({
      success: true,
      gitName: gitConfig?.git_name || null,
      gitEmail: gitConfig?.git_email || null
    });
  } catch (error) {
    console.error('Error getting git config:', error);
    res.status(500).json({ error: 'Failed to get git configuration' });
  }
});

// Apply git config globally via git config --global
router.post('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { gitName, gitEmail } = req.body;

    if (!gitName || !gitEmail) {
      return res.status(400).json({ error: 'Git name and email are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(gitEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    userDb.updateGitConfig(userId, gitName, gitEmail);

    try {
      await execAsync(`git config --global user.name "${gitName.replace(/"/g, '\\"')}"`);
      await execAsync(`git config --global user.email "${gitEmail.replace(/"/g, '\\"')}"`);
      console.log(`Applied git config globally: ${gitName} <${gitEmail}>`);
    } catch (gitError) {
      console.error('Error applying git config:', gitError);
    }

    res.json({
      success: true,
      gitName,
      gitEmail
    });
  } catch (error) {
    console.error('Error updating git config:', error);
    res.status(500).json({ error: 'Failed to update git configuration' });
  }
});

router.post('/complete-onboarding', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    userDb.completeOnboarding(userId);

    res.json({
      success: true,
      message: 'Onboarding completed successfully'
    });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

router.get('/onboarding-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const hasCompleted = userDb.hasCompletedOnboarding(userId);

    res.json({
      success: true,
      hasCompletedOnboarding: hasCompleted
    });
  } catch (error) {
    console.error('Error checking onboarding status:', error);
    res.status(500).json({ error: 'Failed to check onboarding status' });
  }
});

// 头像上传：接收 base64 data URL（前端已压缩到 128x128，约 10-30KB）
// 服务端做尺寸上限校验，避免 SQLite blob 撑爆
const AVATAR_MAX_BYTES = 200 * 1024; // 200KB 上限（base64 解码后），防呆

router.post('/avatar', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { avatar_url: avatarUrl } = req.body || {};

    if (typeof avatarUrl !== 'string' || !avatarUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'avatar_url must be a base64 data URL' });
    }

    // 估算解码后尺寸：base64 长度 * 3/4
    const base64Part = avatarUrl.split(',')[1] || '';
    const approxBytes = Math.floor(base64Part.length * 0.75);
    if (approxBytes > AVATAR_MAX_BYTES) {
      return res.status(413).json({ error: `Avatar too large (>${AVATAR_MAX_BYTES} bytes)` });
    }

    userDb.updateAvatar(userId, avatarUrl);
    res.json({ success: true, avatar_url: avatarUrl });
  } catch (error) {
    console.error('Error uploading avatar:', error);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

router.delete('/avatar', authenticateToken, async (req, res) => {
  try {
    userDb.updateAvatar(req.user.id, null);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing avatar:', error);
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

// 列出全部活跃用户的 (id, username, avatar_url)，前端按 user_id → avatar 索引使用
// 用于消息渲染时按归属显示对应头像（共享数据多账号场景）
router.get('/avatars', authenticateToken, async (req, res) => {
  try {
    const users = userDb.listActiveUsers();
    res.json({ success: true, users });
  } catch (error) {
    console.error('Error listing user avatars:', error);
    res.status(500).json({ error: 'Failed to list user avatars' });
  }
});

export default router;
