// 会话子文件夹路由：仅前端视图层的归类，不动 ~/.claude/projects 下的会话文件
// 设计原则：删除文件夹只清元数据，session 退回根目录，便于误操作恢复
import express from 'express';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { foldersDb } from '../database/db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// 清理孤儿 membership：claude 会话以 <session_id>.jsonl 存于 ~/.claude/projects/<project>/，
// 若文件已被删除（早期 deleteSession 未清 membership，或会话被外部删除），对应行会残留，
// 导致文件夹角标计数虚高（如显示 16，实际只剩 12 个可渲染会话）。这里按文件存在性剔除。
// 仅处理 claude provider —— cursor/codex/gemini 会话存储位置不同，留待其各自删除路径处理，
// 避免误判存在性而错删归属。
function pruneOrphanClaudeMembership(projectName, membership) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  const orphans = [];
  for (const row of membership) {
    if ((row.provider || 'claude') !== 'claude') continue;
    const jsonlFile = path.join(projectDir, `${row.session_id}.jsonl`);
    if (!fsSync.existsSync(jsonlFile)) {
      orphans.push({ session_id: row.session_id, provider: row.provider || 'claude' });
    }
  }
  if (orphans.length > 0) {
    foldersDb.deleteMemberships(projectName, orphans);
  }
  const orphanKeys = new Set(orphans.map((o) => `${o.provider}::${o.session_id}`));
  return membership.filter((row) => !orphanKeys.has(`${row.provider || 'claude'}::${row.session_id}`));
}

// 鉴权放在路由内部、按路径声明，避免外层 app.use('/api', auth, router) 把鉴权
// 扩散到所有 /api/* 路径（曾因此误拦 /api/sys-stats 等公开端点）
router.use('/projects/:projectName/folders', authenticateToken);
router.use('/sessions/:sessionId/folder', authenticateToken);

// 列出某 project 下所有文件夹 + session 归属（前端在内存里拼成树）
router.get('/projects/:projectName/folders', (req, res) => {
  try {
    const { projectName } = req.params;
    const folders = foldersDb.listByProject(projectName);
    const rawMembership = foldersDb.listMembershipByProject(projectName);
    const membership = pruneOrphanClaudeMembership(projectName, rawMembership);
    res.json({ success: true, folders, membership });
  } catch (error) {
    console.error('List folders error:', error);
    res.status(500).json({ error: 'Failed to list folders' });
  }
});

// 创建文件夹：{ name, parent_id?: number|null }
router.post('/projects/:projectName/folders', (req, res) => {
  try {
    const { projectName } = req.params;
    const { name, parent_id: parentId } = req.body || {};
    const folder = foldersDb.create(projectName, name, parentId ?? null);
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(400).json({ error: error.message || 'Failed to create folder' });
  }
});

// 重命名 / 移动文件夹：{ name?, parent_id? }
router.patch('/projects/:projectName/folders/:folderId', (req, res) => {
  try {
    const { projectName, folderId } = req.params;
    const id = parseInt(folderId, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid folder id' });
    const folder = foldersDb.update(projectName, id, req.body || {});
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Update folder error:', error);
    res.status(400).json({ error: error.message || 'Failed to update folder' });
  }
});

// 预览删除将影响多少 session / 子文件夹（供前端确认弹窗使用）
router.get('/projects/:projectName/folders/:folderId/contents-count', (req, res) => {
  try {
    const { projectName, folderId } = req.params;
    const id = parseInt(folderId, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid folder id' });
    const counts = foldersDb.countContents(projectName, id);
    res.json({ success: true, ...counts });
  } catch (error) {
    console.error('Count folder contents error:', error);
    res.status(500).json({ error: 'Failed to count folder contents' });
  }
});

// 删除文件夹（CASCADE 让 session 退根目录，子文件夹通过 SET NULL 升根）
router.delete('/projects/:projectName/folders/:folderId', (req, res) => {
  try {
    const { projectName, folderId } = req.params;
    const id = parseInt(folderId, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid folder id' });
    const result = foldersDb.remove(projectName, id);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Delete folder error:', error);
    res.status(400).json({ error: error.message || 'Failed to delete folder' });
  }
});

// 移动 session 到文件夹（folder_id 为 null 表示移回根目录）
// body: { project_name, provider, folder_id }
router.put('/sessions/:sessionId/folder', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { project_name: projectName, provider = 'claude', folder_id: folderId = null } = req.body || {};
    if (!projectName) return res.status(400).json({ error: 'project_name is required' });
    foldersDb.setSessionFolder(sessionId, provider, projectName, folderId);
    res.json({ success: true });
  } catch (error) {
    console.error('Set session folder error:', error);
    res.status(400).json({ error: error.message || 'Failed to set session folder' });
  }
});

export default router;
