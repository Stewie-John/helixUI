/**
 * PROJECT DISCOVERY AND MANAGEMENT SYSTEM
 * ========================================
 * 
 * This module manages project discovery for both Claude CLI and Cursor CLI sessions.
 * 
 * ## Architecture Overview
 * 
 * 1. **Claude Projects** (stored in ~/.claude/projects/)
 *    - Each project is a directory named with the project path encoded (/ replaced with -)
 *    - Contains .jsonl files with conversation history including 'cwd' field
 *    - Project metadata stored in ~/.claude/project-config.json
 * 
 * 2. **Cursor Projects** (stored in ~/.cursor/chats/)
 *    - Each project directory is named with MD5 hash of the absolute project path
 *    - Example: /Users/john/myproject -> MD5 -> a1b2c3d4e5f6...
 *    - Contains session directories with SQLite databases (store.db)
 *    - Project path is NOT stored in the database - only in the MD5 hash
 * 
 * ## Project Discovery Strategy
 * 
 * 1. **Claude Projects Discovery**:
 *    - Scan ~/.claude/projects/ directory for Claude project folders
 *    - Extract actual project path from .jsonl files (cwd field)
 *    - Fall back to decoded directory name if no sessions exist
 * 
 * 2. **Cursor Sessions Discovery**:
 *    - For each KNOWN project (from Claude or manually added)
 *    - Compute MD5 hash of the project's absolute path
 *    - Check if ~/.cursor/chats/{md5_hash}/ directory exists
 *    - Read session metadata from SQLite store.db files
 * 
 * 3. **Manual Project Addition**:
 *    - Users can manually add project paths via UI
 *    - Stored in ~/.claude/project-config.json with 'manuallyAdded' flag
 *    - Allows discovering Cursor sessions for projects without Claude sessions
 * 
 * ## Critical Limitations
 * 
 * - **CANNOT discover Cursor-only projects**: From a quick check, there was no mention of
 *   the cwd of each project. if someone has the time, you can try to reverse engineer it.
 * 
 * - **Project relocation breaks history**: If a project directory is moved or renamed,
 *   the MD5 hash changes, making old Cursor sessions inaccessible unless the old
 *   path is known and manually added.
 * 
 * ## Error Handling
 * 
 * - Missing ~/.claude directory is handled gracefully with automatic creation
 * - ENOENT errors are caught and handled without crashing
 * - Empty arrays returned when no projects/sessions exist
 * 
 * ## Caching Strategy
 * 
 * - Project directory extraction is cached to minimize file I/O
 * - Cache is cleared when project configuration changes
 * - Session data is fetched on-demand, not cached
 */

import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import os from 'os';
import sessionManager from './sessionManager.js';
import {
  applyCustomSessionNames,
  codexRuntimeAliasesDb,
  codexTranscriptDb,
  foldersDb,
} from './database/db.js';

const CLAUDE_SESSION_ARCHIVE_ROOT = path.join(os.homedir(), '.cloudcli', 'claude-session-archive');
const CLAUDE_SESSION_TRASH_ROOT = path.join(os.homedir(), '.cloudcli', 'claude-session-trash');

function isHiddenRuntimeUserText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return (
    value.startsWith('<turn_aborted>') ||
    value.includes('</turn_aborted>') ||
    value.startsWith('# AGENTS.md instructions for ') ||
    value.startsWith('<INSTRUCTIONS>') ||
    value.startsWith('<environment_context>') ||
    value.startsWith('<permissions instructions>') ||
    value.startsWith('<skills_instructions>') ||
    value.includes('<codex_internal_context') ||
    value.startsWith('Continue an existing browser conversation whose original root rollout is unavailable.') ||
    value.startsWith('The previous conversation was automatically compacted')
  );
}

function isCompactedContextRuntimeText(text) {
  return String(text || '').trim().startsWith('The previous conversation was automatically compacted');
}

function getVisibleRuntimeUserText(text) {
  const value = String(text || '');
  const marker = 'Current user request:';
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const visible = value.slice(markerIndex + marker.length).trim();
    return visible || value;
  }
  return value;
}

function getSessionSummaryFromUserText(text, maxLength = 80) {
  const visibleText = getVisibleRuntimeUserText(text).trim();
  if (!visibleText || isHiddenRuntimeUserText(visibleText)) return null;
  return visibleText.length > maxLength ? `${visibleText.substring(0, maxLength)}...` : visibleText;
}

// Import TaskMaster detection functions
async function detectTaskMasterFolder(projectPath) {
  try {
    const taskMasterPath = path.join(projectPath, '.taskmaster');

    // Check if .taskmaster directory exists
    try {
      const stats = await fs.stat(taskMasterPath);
      if (!stats.isDirectory()) {
        return {
          hasTaskmaster: false,
          reason: '.taskmaster exists but is not a directory'
        };
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          hasTaskmaster: false,
          reason: '.taskmaster directory not found'
        };
      }
      throw error;
    }

    // Check for key TaskMaster files
    const keyFiles = [
      'tasks/tasks.json',
      'config.json'
    ];

    const fileStatus = {};
    let hasEssentialFiles = true;

    for (const file of keyFiles) {
      const filePath = path.join(taskMasterPath, file);
      try {
        await fs.access(filePath);
        fileStatus[file] = true;
      } catch (error) {
        fileStatus[file] = false;
        if (file === 'tasks/tasks.json') {
          hasEssentialFiles = false;
        }
      }
    }

    // Parse tasks.json if it exists for metadata
    let taskMetadata = null;
    if (fileStatus['tasks/tasks.json']) {
      try {
        const tasksPath = path.join(taskMasterPath, 'tasks/tasks.json');
        const tasksContent = await fs.readFile(tasksPath, 'utf8');
        const tasksData = JSON.parse(tasksContent);

        // Handle both tagged and legacy formats
        let tasks = [];
        if (tasksData.tasks) {
          // Legacy format
          tasks = tasksData.tasks;
        } else {
          // Tagged format - get tasks from all tags
          Object.values(tasksData).forEach(tagData => {
            if (tagData.tasks) {
              tasks = tasks.concat(tagData.tasks);
            }
          });
        }

        // Calculate task statistics
        const stats = tasks.reduce((acc, task) => {
          acc.total++;
          acc[task.status] = (acc[task.status] || 0) + 1;

          // Count subtasks
          if (task.subtasks) {
            task.subtasks.forEach(subtask => {
              acc.subtotalTasks++;
              acc.subtasks = acc.subtasks || {};
              acc.subtasks[subtask.status] = (acc.subtasks[subtask.status] || 0) + 1;
            });
          }

          return acc;
        }, {
          total: 0,
          subtotalTasks: 0,
          pending: 0,
          'in-progress': 0,
          done: 0,
          review: 0,
          deferred: 0,
          cancelled: 0,
          subtasks: {}
        });

        taskMetadata = {
          taskCount: stats.total,
          subtaskCount: stats.subtotalTasks,
          completed: stats.done || 0,
          pending: stats.pending || 0,
          inProgress: stats['in-progress'] || 0,
          review: stats.review || 0,
          completionPercentage: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
          lastModified: (await fs.stat(tasksPath)).mtime.toISOString()
        };
      } catch (parseError) {
        console.warn('Failed to parse tasks.json:', parseError.message);
        taskMetadata = { error: 'Failed to parse tasks.json' };
      }
    }

    return {
      hasTaskmaster: true,
      hasEssentialFiles,
      files: fileStatus,
      metadata: taskMetadata,
      path: taskMasterPath
    };

  } catch (error) {
    console.error('Error detecting TaskMaster folder:', error);
    return {
      hasTaskmaster: false,
      reason: `Error checking directory: ${error.message}`
    };
  }
}

// Cache for extracted project directories
const projectDirectoryCache = new Map();

// Clear cache when needed (called when project files change)
function clearProjectDirectoryCache() {
  projectDirectoryCache.clear();
}

// Load project configuration file
async function loadProjectConfig() {
  const configPath = path.join(os.homedir(), '.claude', 'project-config.json');
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    // Return empty config if file doesn't exist
    return {};
  }
}

// Save project configuration file
async function saveProjectConfig(config) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const configPath = path.join(claudeDir, 'project-config.json');

  // Ensure the .claude directory exists
  try {
    await fs.mkdir(claudeDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  // Configuration changes must be visible to the request that immediately
  // follows create/rename/delete. Returning the previous project list here
  // leaves a successfully created workspace invisible until another refresh.
  invalidateProjectsCache(true);
}

// Generate better display name from path
async function generateDisplayName(projectName, actualProjectDir = null) {
  // Use actual project directory if provided, otherwise decode from project name
  let projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData);

    // Return the name from package.json if it exists
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch (error) {
    // Fall back to path-based naming if package.json doesn't exist or can't be read
  }

  // If it starts with /, it's an absolute path
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

// Extract the actual project directory from JSONL sessions (with caching)
async function extractProjectDirectory(projectName) {
  // Check cache first
  if (projectDirectoryCache.has(projectName)) {
    return projectDirectoryCache.get(projectName);
  }

  // Check project config for originalPath (manually added projects via UI or platform)
  // This handles projects with dashes in their directory names correctly
  const config = await loadProjectConfig();
  if (config[projectName]?.originalPath) {
    const originalPath = config[projectName].originalPath;
    projectDirectoryCache.set(projectName, originalPath);
    return originalPath;
  }

  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  let extractedPath;

  try {
    await fs.access(projectDir);

    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

    if (jsonlFiles.length === 0) {
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      // 快速模式：只读最新文件的前几行获取 cwd（不再遍历所有文件所有行）
      // 按修改时间排序，优先读最新的文件
      const filesWithMtime = await Promise.all(
        jsonlFiles.map(async (file) => {
          const stats = await fs.stat(path.join(projectDir, file));
          return { file, mtime: stats.mtime };
        })
      );
      filesWithMtime.sort((a, b) => b.mtime - a.mtime);

      let foundCwd = null;
      // 从最新的文件开始，读前 10 行找 cwd
      for (const { file } of filesWithMtime.slice(0, 3)) {
        const lines = await readFirstLines(path.join(projectDir, file), 10);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.cwd) { foundCwd = entry.cwd; break; }
          } catch { /* skip */ }
        }
        if (foundCwd) break;
      }

      extractedPath = foundCwd || projectName.replace(/-/g, '/');
    }

    projectDirectoryCache.set(projectName, extractedPath);
    return extractedPath;

  } catch (error) {
    if (error.code === 'ENOENT') {
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      console.error(`Error extracting project directory for ${projectName}:`, error);
      extractedPath = projectName.replace(/-/g, '/');
    }
    projectDirectoryCache.set(projectName, extractedPath);
    return extractedPath;
  }
}

// 短期缓存：防止前端快速连续请求（如初始化 + WS 重连）重复扫描文件系统
let _projectsCache = null;
let _projectsCacheTime = 0;
let _projectsCacheStale = false;
let _projectsInFlight = null;
let _projectsCacheLoadPromise = null;
let _projectsRefreshTimer = null;
const PROJECTS_CACHE_TTL = 5 * 60 * 1000;
const PROJECTS_CACHE_FILE = path.join(os.homedir(), '.cloudcli', 'projects-cache.json');

async function loadPersistedProjectsCache() {
  if (_projectsCache || _projectsCacheLoadPromise) return _projectsCacheLoadPromise;
  _projectsCacheLoadPromise = (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(PROJECTS_CACHE_FILE, 'utf8'));
      if (Array.isArray(parsed?.projects)) {
        _projectsCache = parsed.projects;
        _projectsCacheTime = Number(parsed.writtenAt || 0);
      }
    } catch { /* first run or invalid cache */ }
  })();
  await _projectsCacheLoadPromise;
  return _projectsCache;
}

function scheduleProjectsRefresh() {
  if (_projectsInFlight || _projectsRefreshTimer) return;
  _projectsRefreshTimer = setTimeout(() => {
    _projectsRefreshTimer = null;
    void startProjectsScan().catch((error) => {
      console.warn('Background project refresh failed:', error.message);
    });
  }, 2500);
  _projectsRefreshTimer.unref?.();
}

async function getProjects(progressCallback = null) {
  await loadPersistedProjectsCache();
  const cacheExpired = Date.now() - _projectsCacheTime >= PROJECTS_CACHE_TTL;
  if (_projectsCache && !progressCallback) {
    if ((_projectsCacheStale || cacheExpired) && !_projectsInFlight) {
      scheduleProjectsRefresh();
    }
    return _projectsCache;
  }

  return startProjectsScan(progressCallback);
}

function startProjectsScan(progressCallback = null) {
  // Browser reloads and filesystem notifications often arrive together. Share
  // one scan instead of parsing every provider transcript once per caller.
  if (_projectsInFlight) return _projectsInFlight;

  const trackedScan = (async () => {
    try {
      return await scanProjects(progressCallback);
    } finally {
      if (_projectsInFlight === trackedScan) _projectsInFlight = null;
    }
  })();
  _projectsInFlight = trackedScan;
  return trackedScan;
}

async function scanProjects(progressCallback = null) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const config = await loadProjectConfig();
  const projects = [];
  const existingProjects = new Set();
  const codexSessionsIndexRef = { sessionsByProject: null };
  let totalProjects = 0;
  let processedProjects = 0;
  let directories = [];

  try {
    // Check if the .claude/projects directory exists
    await fs.access(claudeDir);

    // First, get existing Claude projects from the file system
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    directories = entries.filter(e => e.isDirectory());

    // Build set of existing project names for later
    directories.forEach(e => existingProjects.add(e.name));

    // Count manual projects not already in directories
    const manualProjectsCount = Object.entries(config)
      .filter(([name, cfg]) => cfg.manuallyAdded && !existingProjects.has(name))
      .length;

    totalProjects = directories.length + manualProjectsCount;

    // 预先构建 Codex sessions 索引（只构建一次，避免并行时重复构建）
    const codexIndex = await buildCodexSessionsIndex();

    // 并行处理所有项目（原来是串行 for 循环，项目多时非常慢）
    const projectPromises = directories.map(async (entry) => {
      processedProjects++;

      // Emit progress
      if (progressCallback) {
        progressCallback({
          phase: 'loading',
          current: processedProjects,
          total: totalProjects,
          currentProject: entry.name
        });
      }

      // Extract actual project directory from JSONL sessions
      const actualProjectDir = await extractProjectDirectory(entry.name);

      // Get display name from config or generate one
      const customName = config[entry.name]?.displayName;
      const autoDisplayName = await generateDisplayName(entry.name, actualProjectDir);
      const fullPath = actualProjectDir;

      const project = {
        name: entry.name,
        path: actualProjectDir,
        displayName: customName || autoDisplayName,
        fullPath: fullPath,
        isCustomName: !!customName,
        sessions: [],
        geminiSessions: [],
        sessionMeta: {
          hasMore: false,
          total: 0
        }
      };

      // 并行加载当前项目的所有 session 类型（原来串行等待）
      const [sessionResult, cursorSessions, codexSessions, geminiSessions, taskMasterResult] =
        await Promise.all([
          getSessions(entry.name, 5, 0).catch(e => {
            console.warn(`Could not load sessions for project ${entry.name}:`, e.message);
            return { sessions: [], hasMore: false, total: 0 };
          }),
          getCursorSessions(actualProjectDir).catch(e => {
            console.warn(`Could not load Cursor sessions for project ${entry.name}:`, e.message);
            return [];
          }),
          getCodexSessions(actualProjectDir, { prebuiltIndex: codexIndex }).catch(e => {
            console.warn(`Could not load Codex sessions for project ${entry.name}:`, e.message);
            return [];
          }),
          Promise.resolve().then(() => {
            try { return sessionManager.getProjectSessions(actualProjectDir) || []; }
            catch (e) { console.warn(`Could not load Gemini sessions for project ${entry.name}:`, e.message); return []; }
          }),
          detectTaskMasterFolder(actualProjectDir).catch(e => {
            console.warn(`Could not detect TaskMaster for project ${entry.name}:`, e.message);
            return { hasTaskmaster: false, hasEssentialFiles: false, metadata: null };
          }),
        ]);

      project.sessions = sessionResult.sessions || [];
      project.sessionMeta = { hasMore: sessionResult.hasMore, total: sessionResult.total };
      applyCustomSessionNames(project.sessions, 'claude');

      project.cursorSessions = cursorSessions;
      applyCustomSessionNames(project.cursorSessions, 'cursor');

      project.codexSessions = codexSessions;
      applyCustomSessionNames(project.codexSessions, 'codex');

      project.geminiSessions = geminiSessions;
      applyCustomSessionNames(project.geminiSessions, 'gemini');

      project.taskmaster = {
        hasTaskmaster: taskMasterResult.hasTaskmaster,
        hasEssentialFiles: taskMasterResult.hasEssentialFiles,
        metadata: taskMasterResult.metadata,
        status: taskMasterResult.hasTaskmaster && taskMasterResult.hasEssentialFiles ? 'configured' : 'not-configured'
      };

      return project;
    });

    projects.push(...await Promise.all(projectPromises));
  } catch (error) {
    // If the directory doesn't exist (ENOENT), that's okay - just continue with empty projects
    if (error.code !== 'ENOENT') {
      console.error('Error reading projects directory:', error);
    }
    // Calculate total for manual projects only (no directories exist)
    totalProjects = Object.entries(config)
      .filter(([name, cfg]) => cfg.manuallyAdded)
      .length;
  }

  // Add manually configured projects that don't exist as folders yet
  for (const [projectName, projectConfig] of Object.entries(config)) {
    if (!existingProjects.has(projectName) && projectConfig.manuallyAdded) {
      processedProjects++;

      // Emit progress for manual projects
      if (progressCallback) {
        progressCallback({
          phase: 'loading',
          current: processedProjects,
          total: totalProjects,
          currentProject: projectName
        });
      }

      // Use the original path if available, otherwise extract from potential sessions
      let actualProjectDir = projectConfig.originalPath;

      if (!actualProjectDir) {
        try {
          actualProjectDir = await extractProjectDirectory(projectName);
        } catch (error) {
          // Fall back to decoded project name
          actualProjectDir = projectName.replace(/-/g, '/');
        }
      }

      const project = {
        name: projectName,
        path: actualProjectDir,
        displayName: projectConfig.displayName || await generateDisplayName(projectName, actualProjectDir),
        fullPath: actualProjectDir,
        isCustomName: !!projectConfig.displayName,
        isManuallyAdded: true,
        sessions: [],
        geminiSessions: [],
        sessionMeta: {
          hasMore: false,
          total: 0
        },
        cursorSessions: [],
        codexSessions: []
      };

      // Try to fetch Cursor sessions for manual projects too
      try {
        project.cursorSessions = await getCursorSessions(actualProjectDir);
      } catch (e) {
        console.warn(`Could not load Cursor sessions for manual project ${projectName}:`, e.message);
      }
      applyCustomSessionNames(project.cursorSessions, 'cursor');

      // Try to fetch Codex sessions for manual projects too
      try {
        project.codexSessions = await getCodexSessions(actualProjectDir, {
          indexRef: codexSessionsIndexRef,
        });
      } catch (e) {
        console.warn(`Could not load Codex sessions for manual project ${projectName}:`, e.message);
      }
      applyCustomSessionNames(project.codexSessions, 'codex');

      // Try to fetch Gemini sessions for manual projects too
      try {
        project.geminiSessions = sessionManager.getProjectSessions(actualProjectDir) || [];
      } catch (e) {
        console.warn(`Could not load Gemini sessions for manual project ${projectName}:`, e.message);
      }
      applyCustomSessionNames(project.geminiSessions, 'gemini');

      // Add TaskMaster detection for manual projects
      try {
        const taskMasterResult = await detectTaskMasterFolder(actualProjectDir);

        // Determine TaskMaster status
        let taskMasterStatus = 'not-configured';
        if (taskMasterResult.hasTaskmaster && taskMasterResult.hasEssentialFiles) {
          taskMasterStatus = 'taskmaster-only'; // We don't check MCP for manual projects in bulk
        }

        project.taskmaster = {
          status: taskMasterStatus,
          hasTaskmaster: taskMasterResult.hasTaskmaster,
          hasEssentialFiles: taskMasterResult.hasEssentialFiles,
          metadata: taskMasterResult.metadata
        };
      } catch (error) {
        console.warn(`TaskMaster detection failed for manual project ${projectName}:`, error.message);
        project.taskmaster = {
          status: 'error',
          hasTaskmaster: false,
          hasEssentialFiles: false,
          error: error.message
        };
      }

      projects.push(project);
    }
  }

  // Emit completion after all projects (including manual) are processed
  if (progressCallback) {
    progressCallback({
      phase: 'complete',
      current: totalProjects,
      total: totalProjects
    });
  }

  // 更新缓存
  _projectsCache = projects;
  _projectsCacheTime = Date.now();
  _projectsCacheStale = false;
  void (async () => {
    try {
      await fs.mkdir(path.dirname(PROJECTS_CACHE_FILE), { recursive: true });
      const temporaryPath = `${PROJECTS_CACHE_FILE}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify({ writtenAt: _projectsCacheTime, projects }));
      await fs.rename(temporaryPath, PROJECTS_CACHE_FILE);
    } catch (error) {
      console.warn('Could not persist project cache:', error.message);
    }
  })();

  return projects;
}

// WebSocket 推送 projects_updated 时清除缓存，确保下次请求获取最新数据
function invalidateProjectsCache(discardCurrent = false) {
  // Keep the last valid list available while its replacement is scanned. This
  // avoids blocking every open browser on thousands of transcript files.
  _projectsCacheStale = true;
  _projectsCacheTime = 0;
  if (discardCurrent) {
    _projectsCache = null;
    // Do not reload the now-stale persisted snapshot before the fresh scan.
    _projectsCacheLoadPromise = Promise.resolve(null);
    void fs.unlink(PROJECTS_CACHE_FILE).catch((error) => {
      if (error.code !== 'ENOENT') console.warn('Could not discard project cache:', error.message);
    });
  }
}

// 快速读取文件前 N 行（不解析整个文件）
async function readFirstLines(filePath, maxLines = 30) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const stream = fsSync.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 16 * 1024 });
    let remainder = '';
    let done = false;

    stream.on('data', (chunk) => {
      if (done) return;
      remainder += chunk;
      const parts = remainder.split('\n');
      remainder = parts.pop(); // 保留最后一个不完整行
      for (const part of parts) {
        if (part.trim()) lines.push(part);
        if (lines.length >= maxLines) { done = true; stream.destroy(); return; }
      }
    });
    stream.on('end', () => resolve(lines));
    stream.on('close', () => resolve(lines));
    stream.on('error', reject);
  });
}

// 快速读取文件尾部获取最后的 timestamp
async function readLastTimestamp(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0) return null;
    // 读取文件最后 8KB 来找最近的 timestamp
    const readSize = Math.min(8192, stat.size);
    const fd = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, stat.size - readSize);
    await fd.close();
    const tail = buf.toString('utf8');
    const lines = tail.split('\n').filter(l => l.trim());
    // 从后往前找有 timestamp 的行
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.timestamp) return new Date(entry.timestamp);
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }
  return null;
}

async function getSessions(projectName, limit = 5, offset = 0) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

    if (jsonlFiles.length === 0) {
      return { sessions: [], hasMore: false, total: 0 };
    }

    // 并行获取所有文件的 stat（用于排序）
    const filesWithStats = await Promise.all(
      jsonlFiles.map(async (file) => {
        const filePath = path.join(projectDir, file);
        const stats = await fs.stat(filePath);
        return { file, filePath, mtime: stats.mtime, size: stats.size };
      })
    );
    filesWithStats.sort((a, b) => b.mtime - a.mtime);

    // 快速模式：只读取每个文件的头部和尾部提取 session 信息
    // 文件名就是 sessionId，mtime 就是 lastActivity
    const sessionPromises = filesWithStats.map(async ({ file, filePath, mtime, size }) => {
      const sessionId = file.replace('.jsonl', '');

      if (size === 0) {
        return null; // 跳过空文件
      }

      const session = {
        id: sessionId,
        summary: 'New Session',
        messageCount: 0,
        lastActivity: mtime,
        cwd: '',
        lastUserMessage: null,
        lastAssistantMessage: null
      };

      try {
        // 只读前 30 行提取 summary 和 cwd
        const headLines = await readFirstLines(filePath, 30);
        let foundUserMsg = false;

        for (const line of headLines) {
          try {
            const entry = JSON.parse(line);
            if (!session.cwd && entry.cwd) session.cwd = entry.cwd;

            // 找第一条非系统 user message 作为 summary
            if (!foundUserMsg && entry.message?.role === 'user' && entry.message?.content) {
              let textContent = entry.message.content;
              if (Array.isArray(textContent) && textContent.length > 0 && textContent[0].type === 'text') {
                textContent = textContent[0].text;
              }
              const summaryText = typeof textContent === 'string'
                ? getSessionSummaryFromUserText(textContent, 80)
                : null;
              if (summaryText &&
                  !textContent.startsWith('<') && !textContent.startsWith('Caveat:') &&
                  !textContent.startsWith('This session is being continued') &&
                  !textContent.startsWith('Invalid API key') &&
                  textContent !== 'Warmup' &&
                  !textContent.includes('{"subtasks":') &&
                  !textContent.includes('CRITICAL: You MUST respond with ONLY a JSON')) {
                session.summary = summaryText;
                session.lastUserMessage = getVisibleRuntimeUserText(textContent).trim();
                foundUserMsg = true;
              }
            }
          } catch { /* skip malformed */ }
        }

        // 从文件尾部获取更精确的 lastActivity
        const lastTs = await readLastTimestamp(filePath);
        if (lastTs) session.lastActivity = lastTs;
      } catch (e) {
        // 如果读取失败，仍然返回基本信息
      }

      // 过滤 JSON 响应的 session（Task Master errors）
      if (session.summary.startsWith('{ "')) return null;

      // 过滤只含 file-history-snapshot 等元数据、没有任何对话内容的幽灵 session
      if (session.summary === 'New Session' && !session.lastUserMessage && !session.cwd) return null;

      return session;
    });

    const allSessions = (await Promise.all(sessionPromises)).filter(Boolean);
    allSessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    const total = allSessions.length;
    const paginatedSessions = allSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return {
      sessions: paginatedSessions,
      hasMore,
      total,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}

async function parseJsonlSessions(filePath) {
  const sessions = new Map();
  const entries = [];
  const pendingSummaries = new Map(); // leafUuid -> summary for entries without sessionId

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          entries.push(entry);

          // Handle summary entries that don't have sessionId yet
          if (entry.type === 'summary' && entry.summary && !entry.sessionId && entry.leafUuid) {
            pendingSummaries.set(entry.leafUuid, entry.summary);
          }

          if (entry.sessionId) {
            if (!sessions.has(entry.sessionId)) {
              sessions.set(entry.sessionId, {
                id: entry.sessionId,
                summary: 'New Session',
                messageCount: 0,
                lastActivity: new Date(),
                cwd: entry.cwd || '',
                lastUserMessage: null,
                lastAssistantMessage: null
              });
            }

            const session = sessions.get(entry.sessionId);

            // Apply pending summary if this entry has a parentUuid that matches a pending summary
            if (session.summary === 'New Session' && entry.parentUuid && pendingSummaries.has(entry.parentUuid)) {
              session.summary = pendingSummaries.get(entry.parentUuid);
            }

            // Update summary from summary entries with sessionId
            if (entry.type === 'summary' && entry.summary) {
              session.summary = entry.summary;
            }

            // Track last user and assistant messages (skip system messages)
            if (entry.message?.role === 'user' && entry.message?.content) {
              const content = entry.message.content;

              // Extract text from array format if needed
              let textContent = content;
              if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
                textContent = content[0].text;
              }

              const visibleText = typeof textContent === 'string'
                ? getVisibleRuntimeUserText(textContent).trim()
                : '';
              const isSystemMessage = typeof textContent === 'string' && (
                visibleText.startsWith('<command-name>') ||
                visibleText.startsWith('<command-message>') ||
                visibleText.startsWith('<command-args>') ||
                visibleText.startsWith('<local-command-stdout>') ||
                visibleText.startsWith('<system-reminder>') ||
                isHiddenRuntimeUserText(visibleText) ||
                visibleText.startsWith('Caveat:') ||
                visibleText.startsWith('This session is being continued from a previous') ||
                visibleText.startsWith('Invalid API key') ||
                visibleText.includes('{"subtasks":') || // Filter Task Master prompts
                visibleText.includes('CRITICAL: You MUST respond with ONLY a JSON') || // Filter Task Master system prompts
                visibleText === 'Warmup' // Explicitly filter out "Warmup"
              );

              if (visibleText && !isSystemMessage) {
                session.lastUserMessage = visibleText;
              }
            } else if (entry.message?.role === 'assistant' && entry.message?.content) {
              // Skip API error messages using the isApiErrorMessage flag
              if (entry.isApiErrorMessage === true) {
                // Skip this message entirely
              } else {
                // Track last assistant text message
                let assistantText = null;

                if (Array.isArray(entry.message.content)) {
                  for (const part of entry.message.content) {
                    if (part.type === 'text' && part.text) {
                      assistantText = part.text;
                    }
                  }
                } else if (typeof entry.message.content === 'string') {
                  assistantText = entry.message.content;
                }

                // Additional filter for assistant messages with system content
                const isSystemAssistantMessage = typeof assistantText === 'string' && (
                  assistantText.startsWith('Invalid API key') ||
                  assistantText.includes('{"subtasks":') ||
                  assistantText.includes('CRITICAL: You MUST respond with ONLY a JSON')
                );

                if (assistantText && !isSystemAssistantMessage) {
                  session.lastAssistantMessage = assistantText;
                }
              }
            }

            session.messageCount++;

            if (entry.timestamp) {
              session.lastActivity = new Date(entry.timestamp);
            }
          }
        } catch (parseError) {
          // Skip malformed lines silently
        }
      }
    }

    // After processing all entries, set final summary based on last message if no summary exists
    for (const session of sessions.values()) {
      if (session.summary === 'New Session') {
        // Prefer last user message, fall back to last assistant message
        const lastMessage = session.lastUserMessage || session.lastAssistantMessage;
        if (lastMessage) {
          session.summary = lastMessage.length > 50 ? lastMessage.substring(0, 50) + '...' : lastMessage;
        }
      }
    }

    // Filter out sessions that contain JSON responses (Task Master errors)
    const allSessions = Array.from(sessions.values());
    const filteredSessions = allSessions.filter(session => {
      const shouldFilter = session.summary.startsWith('{ "');
      if (shouldFilter) {
      }
      // Log a sample of summaries to debug
      if (Math.random() < 0.01) { // Log 1% of sessions
      }
      return !shouldFilter;
    });


    return {
      sessions: filteredSessions,
      entries: entries
    };

  } catch (error) {
    console.error('Error reading JSONL file:', error);
    return { sessions: [], entries: [] };
  }
}

// Parse an agent JSONL file and extract tool uses
async function parseAgentTools(filePath) {
  const tools = [];

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          // Look for assistant messages with tool_use
          if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'tool_use') {
                tools.push({
                  toolId: part.id,
                  toolName: part.name,
                  toolInput: part.input,
                  timestamp: entry.timestamp
                });
              }
            }
          }
          // Look for tool results
          if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'tool_result') {
                // Find the matching tool and add result
                const tool = tools.find(t => t.toolId === part.tool_use_id);
                if (tool) {
                  tool.toolResult = {
                    content: typeof part.content === 'string' ? part.content :
                      Array.isArray(part.content) ? part.content.map(c => c.text || '').join('\n') :
                        JSON.stringify(part.content),
                    isError: Boolean(part.is_error)
                  };
                }
              }
            }
          }
        } catch (parseError) {
          // Skip malformed lines
        }
      }
    }
  } catch (error) {
    console.warn(`Error parsing agent file ${filePath}:`, error.message);
  }

  return tools;
}

// Get messages for a specific session with pagination support
async function getSessionMessages(projectName, sessionId, limit = null, offset = 0) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const files = await fs.readdir(projectDir);
    const agentFiles = files.filter(file => file.endsWith('.jsonl') && file.startsWith('agent-'));

    // 优化：sessionId 就是文件名，直接读取目标文件，不再遍历所有 JSONL
    const targetFile = `${sessionId}.jsonl`;
    const targetPath = path.join(projectDir, targetFile);
    let jsonlFilesToRead = [];

    try {
      await fs.access(targetPath);
      jsonlFilesToRead = [targetFile];
    } catch {
      // 目标文件不存在，回退到遍历所有文件（兼容旧格式）
      jsonlFilesToRead = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));
    }

    if (jsonlFilesToRead.length === 0) {
      return { messages: [], total: 0, hasMore: false };
    }

    const messages = [];
    const agentToolsCache = new Map();

    for (const file of jsonlFilesToRead) {
      const jsonlFile = path.join(projectDir, file);
      const fileStream = fsSync.createReadStream(jsonlFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry.sessionId === sessionId) {
              messages.push(entry);
            }
          } catch (parseError) {
            // 静默跳过格式错误的行（不再 console.warn 刷屏）
          }
        }
      }
    }

    // Collect agentIds from Task tool results
    const agentIds = new Set();
    for (const message of messages) {
      if (message.toolUseResult?.agentId) {
        agentIds.add(message.toolUseResult.agentId);
      }
    }

    // Load agent tools for each agentId found
    for (const agentId of agentIds) {
      const agentFileName = `agent-${agentId}.jsonl`;
      if (agentFiles.includes(agentFileName)) {
        const agentFilePath = path.join(projectDir, agentFileName);
        const tools = await parseAgentTools(agentFilePath);
        agentToolsCache.set(agentId, tools);
      }
    }

    // Attach agent tools to their parent Task messages
    for (const message of messages) {
      if (message.toolUseResult?.agentId) {
        const agentId = message.toolUseResult.agentId;
        const agentTools = agentToolsCache.get(agentId);
        if (agentTools && agentTools.length > 0) {
          message.subagentTools = agentTools;
        }
      }
    }
    // Sort messages by timestamp
    const sortedMessages = messages.sort((a, b) =>
      new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
    );

    const total = sortedMessages.length;

    // If no limit is specified, return all messages (backward compatibility)
    if (limit === null) {
      return sortedMessages;
    }

    // Apply pagination - for recent messages, we need to slice from the end
    // offset 0 should give us the most recent messages
    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

// Rename a project's display name
async function renameProject(projectName, newDisplayName) {
  const config = await loadProjectConfig();

  if (!newDisplayName || newDisplayName.trim() === '') {
    // Remove custom name if empty, will fall back to auto-generated
    if (config[projectName]) {
      delete config[projectName].displayName;
    }
  } else {
    // Set custom display name, preserving other properties (manuallyAdded, originalPath)
    config[projectName] = {
      ...config[projectName],
      displayName: newDisplayName.trim()
    };
  }

  await saveProjectConfig(config);
  return true;
}

// Delete a session from a project
async function deleteSession(projectName, sessionId) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  // 每个 session 以自己的 UUID 命名文件，直接按名删除，避免按行内 sessionId 匹配时
  // 遗漏 file-history-snapshot 等无 sessionId 字段的行，导致文件残留、session 反复出现。
  const jsonlFile = path.join(projectDir, `${sessionId}.jsonl`);
  const sessionSubDir = path.join(projectDir, sessionId);
  const archivedJsonlFile = path.join(CLAUDE_SESSION_ARCHIVE_ROOT, projectName, `${sessionId}.jsonl`);
  const archiveTombstoneDir = path.join(CLAUDE_SESSION_ARCHIVE_ROOT, projectName, '.deleted');
  const archiveTombstone = path.join(archiveTombstoneDir, sessionId);
  const trashDir = path.join(CLAUDE_SESSION_TRASH_ROOT, projectName);
  const trashJsonlFile = path.join(trashDir, `${sessionId}.jsonl`);
  const trashMetadataFile = path.join(trashDir, `${sessionId}.json`);

  // Deleting in the UI is a soft delete. Preserve the largest available
  // transcript copy locally before hiding it from Claude and the sidebar.
  await fs.mkdir(trashDir, { recursive: true });
  const transcriptCandidates = [];
  for (const candidate of [jsonlFile, archivedJsonlFile, trashJsonlFile]) {
    try {
      const stats = await fs.stat(candidate);
      transcriptCandidates.push({ candidate, size: stats.size });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  transcriptCandidates.sort((a, b) => b.size - a.size);
  if (transcriptCandidates.length > 0 && transcriptCandidates[0].candidate !== trashJsonlFile) {
    const temporaryTrash = `${trashJsonlFile}.tmp`;
    await fs.copyFile(transcriptCandidates[0].candidate, temporaryTrash);
    await fs.rename(temporaryTrash, trashJsonlFile);
  }
  await fs.writeFile(trashMetadataFile, JSON.stringify({
    sessionId,
    projectName,
    provider: 'claude',
    deletedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  // Write a durable tombstone before either unlink. The archive daemon checks
  // this marker, so a deliberately deleted conversation cannot be restored by
  // a race between its source and archive copies.
  await fs.mkdir(archiveTombstoneDir, { recursive: true });
  await fs.writeFile(archiveTombstone, new Date().toISOString(), 'utf8');

  try {
    await fs.unlink(archivedJsonlFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    await fs.unlink(jsonlFile);
  } catch (error) {
    // Deletion is idempotent. A repeated click or a file watcher may have
    // removed the source already; the tombstone still makes the request done.
    if (error.code !== 'ENOENT') {
      console.error(`Error deleting session file ${jsonlFile}:`, error);
      throw error;
    }
  }

  // 删除 subagents 子目录（若存在）
  try {
    await fs.rm(sessionSubDir, { recursive: true, force: true });
  } catch {
    // 目录不存在时忽略
  }

  // 同步清理该会话的文件夹归属，避免遗留孤儿 membership 行使文件夹角标计数虚高
  try {
    foldersDb.setSessionFolder(sessionId, 'claude', projectName, null);
  } catch {
    // 归属清理失败不影响会话删除主流程
  }

  return true;
}

// Check if a project is empty (has no sessions)
async function isProjectEmpty(projectName) {
  try {
    const sessionsResult = await getSessions(projectName, 1, 0);
    return sessionsResult.total === 0;
  } catch (error) {
    console.error(`Error checking if project ${projectName} is empty:`, error);
    return false;
  }
}

// Delete a project (force=true to delete even with sessions)
async function deleteProject(projectName, force = false) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const isEmpty = await isProjectEmpty(projectName);
    if (!isEmpty && !force) {
      throw new Error('Cannot delete project with existing sessions');
    }

    const config = await loadProjectConfig();
    let projectPath = config[projectName]?.path || config[projectName]?.originalPath;

    // Fallback to extractProjectDirectory if projectPath is not in config
    if (!projectPath) {
      projectPath = await extractProjectDirectory(projectName);
    }

    // Remove the project directory (includes all Claude sessions)
    await fs.rm(projectDir, { recursive: true, force: true });

    // Delete all Codex sessions associated with this project
    if (projectPath) {
      try {
        const codexSessions = await getCodexSessions(projectPath, { limit: 0 });
        for (const session of codexSessions) {
          try {
            await deleteCodexSession(session.id);
          } catch (err) {
            console.warn(`Failed to delete Codex session ${session.id}:`, err.message);
          }
        }
      } catch (err) {
        console.warn('Failed to delete Codex sessions:', err.message);
      }

      // Delete Cursor sessions directory if it exists
      try {
        const hash = crypto.createHash('md5').update(projectPath).digest('hex');
        const cursorProjectDir = path.join(os.homedir(), '.cursor', 'chats', hash);
        await fs.rm(cursorProjectDir, { recursive: true, force: true });
      } catch (err) {
        // Cursor dir may not exist, ignore
      }
    }

    // Remove from project config
    delete config[projectName];
    await saveProjectConfig(config);

    return true;
  } catch (error) {
    console.error(`Error deleting project ${projectName}:`, error);
    throw error;
  }
}

// Add a project manually to the config (without creating folders)
async function addProjectManually(projectPath, displayName = null) {
  const absolutePath = path.resolve(projectPath);

  try {
    // Check if the path exists
    await fs.access(absolutePath);
  } catch (error) {
    throw new Error(`Path does not exist: ${absolutePath}`);
  }

  // Generate project name (encode path for use as directory name)
  const projectName = absolutePath.replace(/[\\/:\s~_]/g, '-');

  // Check if project already exists in config
  const config = await loadProjectConfig();
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  if (config[projectName]) {
    const configuredPath = config[projectName].originalPath || config[projectName].path;
    if (configuredPath && path.resolve(configuredPath) === absolutePath) {
      // Retrying after a slow/stale UI refresh is safe and should return the
      // already-created workspace instead of turning success into an error.
      invalidateProjectsCache(true);
      return {
        name: projectName,
        path: absolutePath,
        fullPath: absolutePath,
        displayName: config[projectName].displayName || displayName || await generateDisplayName(projectName, absolutePath),
        isManuallyAdded: true,
        sessions: [],
        cursorSessions: []
      };
    }
    throw new Error(`Project name is already configured for another path: ${absolutePath}`);
  }

  // Allow adding projects even if the directory exists - this enables tracking
  // existing Claude Code or Cursor projects in the UI

  // Add to config as manually added project
  config[projectName] = {
    manuallyAdded: true,
    originalPath: absolutePath
  };

  if (displayName) {
    config[projectName].displayName = displayName;
  }

  await saveProjectConfig(config);


  return {
    name: projectName,
    path: absolutePath,
    fullPath: absolutePath,
    displayName: displayName || await generateDisplayName(projectName, absolutePath),
    isManuallyAdded: true,
    sessions: [],
    cursorSessions: []
  };
}

// Fetch Cursor sessions for a given project path
async function getCursorSessions(projectPath) {
  try {
    // Calculate cwdID hash for the project path (Cursor uses MD5 hash)
    const cwdId = crypto.createHash('md5').update(projectPath).digest('hex');
    const cursorChatsPath = path.join(os.homedir(), '.cursor', 'chats', cwdId);

    // Check if the directory exists
    try {
      await fs.access(cursorChatsPath);
    } catch (error) {
      // No sessions for this project
      return [];
    }

    // List all session directories
    const sessionDirs = await fs.readdir(cursorChatsPath);
    const sessions = [];

    for (const sessionId of sessionDirs) {
      const sessionPath = path.join(cursorChatsPath, sessionId);
      const storeDbPath = path.join(sessionPath, 'store.db');

      try {
        // Check if store.db exists
        await fs.access(storeDbPath);

        // Capture store.db mtime as a reliable fallback timestamp
        let dbStatMtimeMs = null;
        try {
          const stat = await fs.stat(storeDbPath);
          dbStatMtimeMs = stat.mtimeMs;
        } catch (_) { }

        const db = new Database(storeDbPath, { readonly: true, fileMustExist: true });

        // Get metadata from meta table
        const metaRows = db.prepare(`
          SELECT key, value FROM meta
        `).all();

        // Parse metadata
        let metadata = {};
        for (const row of metaRows) {
          if (row.value) {
            try {
              // Try to decode as hex-encoded JSON
              const hexMatch = row.value.toString().match(/^[0-9a-fA-F]+$/);
              if (hexMatch) {
                const jsonStr = Buffer.from(row.value, 'hex').toString('utf8');
                metadata[row.key] = JSON.parse(jsonStr);
              } else {
                metadata[row.key] = row.value.toString();
              }
            } catch (e) {
              metadata[row.key] = row.value.toString();
            }
          }
        }

        // Get message count
        const messageCountResult = db.prepare(`
          SELECT COUNT(*) as count FROM blobs
        `).get();

        db.close();

        // Extract session info
        const sessionName = metadata.title || metadata.sessionTitle || 'Untitled Session';

        // Determine timestamp - prefer createdAt from metadata, fall back to db file mtime
        let createdAt = null;
        if (metadata.createdAt) {
          createdAt = new Date(metadata.createdAt).toISOString();
        } else if (dbStatMtimeMs) {
          createdAt = new Date(dbStatMtimeMs).toISOString();
        } else {
          createdAt = new Date().toISOString();
        }

        sessions.push({
          id: sessionId,
          name: sessionName,
          createdAt: createdAt,
          lastActivity: createdAt, // For compatibility with Claude sessions
          messageCount: messageCountResult.count || 0,
          projectPath: projectPath
        });

      } catch (error) {
        console.warn(`Could not read Cursor session ${sessionId}:`, error.message);
      }
    }

    // Sort sessions by creation time (newest first)
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Return only the first 5 sessions for performance
    return sessions.slice(0, 5);

  } catch (error) {
    console.error('Error fetching Cursor sessions:', error);
    return [];
  }
}


function normalizeComparablePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return '';
  }

  const withoutLongPathPrefix = inputPath.startsWith('\\\\?\\')
    ? inputPath.slice(4)
    : inputPath;
  const normalized = path.normalize(withoutLongPathPrefix.trim());

  if (!normalized) {
    return '';
  }

  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function findCodexJsonlFiles(dir) {
  const files = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findCodexJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }

  return files;
}

function isCodexSubagentSessionMeta(payload) {
  return Boolean(
    payload && (
      payload.thread_source === 'subagent' ||
      payload.source === 'subagent' ||
      payload.source?.subagent
    )
  );
}

// Read enough of the rollout head to get past injected policy/context records.
// Some real user messages occur after line 20 and were previously omitted from
// the sidebar even though their cwd belonged to the project.
async function parseCodexSessionFileFast(filePath, runtimeAliases = null) {
  try {
    let sessionMeta = null;
    let firstUserMessage = null;
    let isCompactContinuation = false;
    let isSubagent = false;
    let lineCount = 0;
    const stream = fsSync.createReadStream(filePath);
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of lines) {
        lineCount += 1;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_meta' && entry.payload) {
          isSubagent = isSubagent || isCodexSubagentSessionMeta(entry.payload);
          sessionMeta = {
            id: entry.payload.id,
            cwd: entry.payload.cwd,
            model: entry.payload.model || entry.payload.model_provider,
            timestamp: entry.timestamp,
          };
        }
        if (
          !firstUserMessage &&
          entry.type === 'event_msg' &&
          entry.payload?.type === 'user_message' &&
          entry.payload.message
        ) {
          if (isCompactedContextRuntimeText(entry.payload.message)) {
            isCompactContinuation = true;
          }
          const visibleMessage = getVisibleRuntimeUserText(entry.payload.message).trim();
          if (visibleMessage && !isHiddenRuntimeUserText(visibleMessage)) {
            firstUserMessage = visibleMessage;
          }
        }
      } catch { /* skip */ }
        // Most rollouts have both values in their first few records. Stop as
        // soon as the sidebar metadata is complete instead of reading 200
        // potentially huge policy/context records from every file.
        if ((sessionMeta && firstUserMessage) || lineCount >= 200) break;
      }
    } finally {
      lines.close();
      stream.destroy();
    }

    const logicalSessionId = sessionMeta?.id ? runtimeAliases?.get(sessionMeta.id) : null;
    // Codex stores every spawned research/worker agent as its own rollout.
    // Those files belong inside the parent turn and must never become sidebar
    // conversations, regardless of how many nested session_meta records follow.
    if (isSubagent) return null;

    if (sessionMeta && (firstUserMessage || logicalSessionId)) {
      // 用文件 mtime 作为 lastActivity（比解析整个文件快得多）
      const stat = await fs.stat(filePath);
      return {
        ...sessionMeta,
        id: logicalSessionId || sessionMeta.id,
        runtimeThreadId: logicalSessionId ? sessionMeta.id : undefined,
        timestamp: stat.mtime.toISOString(),
        summary: getSessionSummaryFromUserText(firstUserMessage || '', 50) || 'Codex Session',
        messageCount: 1,
        isCompactContinuation,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function buildCodexSessionsIndex() {
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const sessionsByProject = new Map();
  const seenPhysicalFiles = new Set();
  const runtimeAliases = codexRuntimeAliasesDb.getAll();

  try {
    await fs.access(codexSessionsDir);
  } catch (error) {
    return sessionsByProject;
  }

  const jsonlFiles = await findCodexJsonlFiles(codexSessionsDir);

  // Keep filesystem and JSON parsing pressure bounded. Opening every rollout at
  // once made a cold page load compete with hundreds of streams.
  const results = [];
  const concurrency = 16;
  for (let offset = 0; offset < jsonlFiles.length; offset += concurrency) {
    const batch = jsonlFiles.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(batch.map(async (filePath) => {
      try {
        const sessionData = await parseCodexSessionFileFast(filePath, runtimeAliases);
        if (!sessionData || !sessionData.id) return null;
        return { sessionData, filePath };
      } catch {
        return null;
      }
    }));
    results.push(...batchResults);
  }

  for (const result of results) {
    if (!result) continue;
    const { sessionData, filePath } = result;

    // A compatibility symlink or a duplicated rollout must not create a
    // second sidebar row for the same physical transcript.
    const physicalFilePath = await fs.realpath(filePath).catch(() => filePath);
    if (seenPhysicalFiles.has(physicalFilePath)) continue;
    seenPhysicalFiles.add(physicalFilePath);

    const normalizedProjectPath = normalizeComparablePath(sessionData.cwd);
    if (!normalizedProjectPath) continue;

    const session = {
      id: sessionData.id,
      summary: sessionData.summary || 'Codex Session',
      messageCount: sessionData.messageCount || 0,
      lastActivity: sessionData.timestamp ? new Date(sessionData.timestamp) : new Date(),
      cwd: sessionData.cwd,
      model: sessionData.model,
      filePath,
      provider: 'codex',
      isCompactContinuation: Boolean(sessionData.isCompactContinuation),
    };

    if (!sessionsByProject.has(normalizedProjectPath)) {
      sessionsByProject.set(normalizedProjectPath, new Map());
    }
    const projectSessions = sessionsByProject.get(normalizedProjectPath);
    const previous = projectSessions.get(session.id);
    // Codex can emit several rollout files for one logical thread. Retain the
    // newest record; transcript loading resolves the logical id from metadata.
    if (!previous || new Date(session.lastActivity) > new Date(previous.lastActivity)) {
      projectSessions.set(session.id, session);
    }
  }

  for (const [projectPath, sessionMap] of sessionsByProject.entries()) {
    const sessions = Array.from(sessionMap.values());
    sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    sessionsByProject.set(projectPath, sessions);
  }

  return sessionsByProject;
}

// Fetch Codex sessions for a given project path
async function getCodexSessions(projectPath, options = {}) {
  const { limit = 0, indexRef = null, prebuiltIndex = null } = options;
  try {
    const normalizedProjectPath = normalizeComparablePath(projectPath);
    if (!normalizedProjectPath) {
      return [];
    }

    // 优先使用预构建索引，避免重复解析 235MB codex 文件
    let sessionsByProject;
    if (prebuiltIndex) {
      sessionsByProject = prebuiltIndex;
    } else if (indexRef && indexRef.sessionsByProject) {
      sessionsByProject = indexRef.sessionsByProject;
    } else {
      sessionsByProject = await buildCodexSessionsIndex();
      if (indexRef) indexRef.sessionsByProject = sessionsByProject;
    }

    const sessions = sessionsByProject.get(normalizedProjectPath) || [];

    // Return limited sessions for performance (0 = unlimited for deletion)
    return limit > 0 ? sessions.slice(0, limit) : [...sessions];

  } catch (error) {
    console.error('Error fetching Codex sessions:', error);
    return [];
  }
}

// Codex compaction can retain a historical display/session id inside a newer
// rollout. The app-server only resumes the first (physical) thread id recorded
// by that rollout, so resolve it separately from the sidebar's logical id.
async function resolveCodexRuntimeThreadId(sessionId) {
  if (!sessionId) return { threadId: null, needsFreshRoot: false };

  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const jsonlFiles = await findCodexJsonlFiles(codexSessionsDir);
  for (const filePath of jsonlFiles) {
    const lines = await readFirstLines(filePath, 40);
    let primaryThreadId = null;
    let primaryThreadSource = null;
    let containsRequestedSession = false;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'session_meta' || !entry.payload?.id) continue;
        if (!primaryThreadId) {
          primaryThreadId = entry.payload.id;
          primaryThreadSource = isCodexSubagentSessionMeta(entry.payload)
            ? 'subagent'
            : entry.payload.thread_source;
        }
        if (entry.payload.id === sessionId) {
          containsRequestedSession = true;
        }
      } catch {
        // Ignore malformed JSONL entries while resolving a historical session.
      }
    }

    if (containsRequestedSession) {
      const isSubagent = primaryThreadSource === 'subagent';
      return {
        threadId: isSubagent ? null : (primaryThreadId || sessionId),
        needsFreshRoot: isSubagent,
      };
    }
  }

  return { threadId: sessionId, needsFreshRoot: false };
}

// Parse a Codex session JSONL file to extract metadata
async function parseCodexSessionFile(filePath) {
  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let sessionMeta = null;
    let lastTimestamp = null;
    let lastUserMessage = null;
    let isCompactContinuation = false;
    let messageCount = 0;

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);

          // Track timestamp
          if (entry.timestamp) {
            lastTimestamp = entry.timestamp;
          }

          // Extract session metadata
          if (entry.type === 'session_meta' && entry.payload) {
            sessionMeta = {
              id: entry.payload.id,
              cwd: entry.payload.cwd,
              model: entry.payload.model || entry.payload.model_provider,
              timestamp: entry.timestamp,
              git: entry.payload.git
            };
          }

          // Count messages and extract user messages for summary
          if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
            if (!lastUserMessage && isCompactedContextRuntimeText(entry.payload.message)) {
              isCompactContinuation = true;
            }
            const visibleMessage = getVisibleRuntimeUserText(entry.payload.message).trim();
            if (visibleMessage && !isHiddenRuntimeUserText(visibleMessage)) {
              messageCount++;
              lastUserMessage = visibleMessage;
            }
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
            messageCount++;
          }

        } catch (parseError) {
          // Skip malformed lines
        }
      }
    }

    if (sessionMeta && messageCount > 0) {
      return {
        ...sessionMeta,
        timestamp: lastTimestamp || sessionMeta.timestamp,
        summary: getSessionSummaryFromUserText(lastUserMessage, 50) || 'Codex Session',
        messageCount,
        isCompactContinuation,
      };
    }

    return null;

  } catch (error) {
    console.error('Error parsing Codex session file:', error);
    return null;
  }
}

const CODEX_PAGED_CACHE_MIN_MESSAGES = 120;
const CODEX_PAGED_CACHE_MAX_SESSIONS = 8;
const codexSessionFilePathCache = new Map();
const codexPagedMessageCache = new Map();
const codexPagedMessageRefreshes = new Map();
const codexCompleteMessageReads = new Map();

const codexMessageTimestamp = (message) => {
  const parsed = Date.parse(String(message?.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortCodexMessages = (messages) => messages.sort((a, b) => {
  const timeDiff = codexMessageTimestamp(a) - codexMessageTimestamp(b);
  return timeDiff || String(a.id || '').localeCompare(String(b.id || ''));
});

const hashCodexJournalKey = (role, content) => crypto
  .createHash('sha1')
  .update(String(role || ''))
  .update('\u0000')
  .update(String(content || ''))
  .digest('base64url');

const getCodexMessageJournalKey = (message) => {
  if (!['user', 'assistant', 'error'].includes(message?.type)) return null;
  return hashCodexJournalKey(
    message.message?.role || message.type,
    message.message?.content ?? message.content ?? '',
  );
};

const getCodexExactMessageKey = (message) => {
  if (!message) return null;
  const role = message.message?.role || message.type || '';
  const content = message.message?.content ?? message.content ?? '';
  const toolIdentity = message.toolCallId || '';
  const toolPayload = message.type === 'tool_use'
    ? `${message.toolName || ''}\u0000${JSON.stringify(message.toolInput ?? null)}`
    : message.type === 'tool_result' ? String(message.output ?? '') : '';
  return crypto
    .createHash('sha1')
    .update(String(role))
    .update('\u0000')
    .update(String(message.timestamp || ''))
    .update('\u0000')
    .update(String(content))
    .update('\u0000')
    .update(String(toolIdentity))
    .update('\u0000')
    .update(toolPayload)
    .digest('base64url');
};

const extractCodexText = (content) => {
  if (!Array.isArray(content)) return content;
  return content
    .map((item) => {
      if (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') {
        return item.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

function parseCodexTranscriptLine(line, sessionId, sourceId, sourceLineNumber) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { valid: false, message: null, tokenUsage: null };
  }

  let tokenUsage = null;
  if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
    const info = entry.payload.info;
    const usage = info.last_token_usage || info.total_token_usage;
    if (usage) {
      tokenUsage = {
        used: Number(
          usage.total_tokens ||
          Number(usage.input_tokens || usage.prompt_tokens || usage.total_input_tokens || 0) +
          Number(usage.output_tokens || 0)
        ),
        total: Number(info.model_context_window || process.env.CODEX_CONTEXT_WINDOW || 1050000),
        timestamp: entry.timestamp,
      };
    }
  }

  if (entry.type !== 'response_item') {
    return { valid: true, message: null, tokenUsage };
  }

  const payload = entry.payload || {};
  const idPrefix = `codex:${sessionId}:${sourceId}:${sourceLineNumber}`;

  if (payload.type === 'message') {
    const role = payload.role || 'assistant';
    const textContent = getVisibleRuntimeUserText(extractCodexText(payload.content));
    if (!textContent?.trim() || isHiddenRuntimeUserText(textContent)) {
      return { valid: true, message: null, tokenUsage };
    }
    return {
      valid: true,
      tokenUsage,
      message: {
        id: `${idPrefix}:message`,
        type: role === 'user' ? 'user' : 'assistant',
        timestamp: entry.timestamp,
        message: { role, content: textContent },
      },
    };
  }

  if (payload.type === 'reasoning') {
    const summaryText = payload.summary?.map((item) => item.text).filter(Boolean).join('\n');
    return {
      valid: true,
      tokenUsage,
      message: summaryText?.trim() ? {
        id: `${idPrefix}:reasoning`,
        type: 'thinking',
        timestamp: entry.timestamp,
        message: { role: 'assistant', content: summaryText },
      } : null,
    };
  }

  if (payload.type === 'function_call') {
    let toolName = payload.name;
    let toolInput = payload.arguments;
    if (toolName === 'shell_command') {
      toolName = 'Bash';
      try {
        const args = JSON.parse(payload.arguments);
        toolInput = JSON.stringify({ command: args.command });
      } catch {
        // Preserve the raw arguments when the payload is not valid JSON.
      }
    }
    return {
      valid: true,
      tokenUsage,
      message: {
        id: `${idPrefix}:function-call`,
        type: 'tool_use',
        timestamp: entry.timestamp,
        toolName,
        toolInput,
        toolCallId: payload.call_id,
      },
    };
  }

  if (payload.type === 'function_call_output') {
    return {
      valid: true,
      tokenUsage,
      message: {
        id: `${idPrefix}:function-result`,
        type: 'tool_result',
        timestamp: entry.timestamp,
        toolCallId: payload.call_id,
        output: payload.output,
      },
    };
  }

  if (payload.type === 'custom_tool_call') {
    const toolName = payload.name || 'custom_tool';
    const input = payload.input || '';
    let mappedToolName = toolName;
    let mappedToolInput = input;
    if (toolName === 'apply_patch') {
      const fileMatch = input.match(/\*\*\* Update File: (.+)/);
      const oldLines = [];
      const newLines = [];
      for (const patchLine of input.split('\n')) {
        if (patchLine.startsWith('-') && !patchLine.startsWith('---')) {
          oldLines.push(patchLine.substring(1));
        } else if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) {
          newLines.push(patchLine.substring(1));
        }
      }
      mappedToolName = 'Edit';
      mappedToolInput = JSON.stringify({
        file_path: fileMatch ? fileMatch[1].trim() : 'unknown',
        old_string: oldLines.join('\n'),
        new_string: newLines.join('\n'),
      });
    }
    return {
      valid: true,
      tokenUsage,
      message: {
        id: `${idPrefix}:custom-call`,
        type: 'tool_use',
        timestamp: entry.timestamp,
        toolName: mappedToolName,
        toolInput: mappedToolInput,
        toolCallId: payload.call_id,
      },
    };
  }

  if (payload.type === 'custom_tool_call_output') {
    return {
      valid: true,
      tokenUsage,
      message: {
        id: `${idPrefix}:custom-result`,
        type: 'tool_result',
        timestamp: entry.timestamp,
        toolCallId: payload.call_id,
        output: payload.output || '',
      },
    };
  }

  return { valid: true, message: null, tokenUsage };
}

// Scan only complete JSONL records. If the writer is in the middle of a line,
// leave that byte range uncommitted so the next refresh parses it in full.
async function scanCodexFileRange(filePath, startOffset, startLineNumber, sessionId, onParsed) {
  const sourceId = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 10);
  const stream = fsSync.createReadStream(filePath, { start: startOffset });
  let absoluteOffset = startOffset;
  let committedOffset = startOffset;
  let lineNumber = startLineNumber;
  let lineParts = [];
  let lineLength = 0;

  const parseLineBuffer = (lineBuffer, hasTerminatingNewline, lineEndOffset) => {
    const text = lineBuffer.toString('utf8').replace(/\r$/, '');
    const nextLineNumber = lineNumber + 1;
    const parsed = text.trim()
      ? parseCodexTranscriptLine(text, sessionId, sourceId, nextLineNumber)
      : { valid: true, message: null, tokenUsage: null };
    if (hasTerminatingNewline || parsed.valid) {
      lineNumber = nextLineNumber;
      committedOffset = lineEndOffset;
      onParsed(parsed);
      return true;
    }
    return false;
  };

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let cursor = 0;
    let newlineIndex = chunk.indexOf(0x0a, cursor);
    while (newlineIndex !== -1) {
      const segment = chunk.subarray(cursor, newlineIndex);
      const completeLine = lineParts.length > 0
        ? Buffer.concat([...lineParts, segment], lineLength + segment.length)
        : segment;
      parseLineBuffer(completeLine, true, absoluteOffset + newlineIndex + 1);
      lineParts = [];
      lineLength = 0;
      cursor = newlineIndex + 1;
      newlineIndex = chunk.indexOf(0x0a, cursor);
    }
    if (cursor < chunk.length) {
      const remainder = chunk.subarray(cursor);
      lineParts.push(Buffer.from(remainder));
      lineLength += remainder.length;
    }
    absoluteOffset += chunk.length;
  }

  if (lineLength > 0) {
    parseLineBuffer(Buffer.concat(lineParts, lineLength), false, absoluteOffset);
  }

  return { processedSize: committedOffset, lineNumber };
}

async function findCodexSessionFile(codexSessionsDir, targetSessionId) {
  const cachedPath = codexSessionFilePathCache.get(targetSessionId);
  if (cachedPath) {
    try {
      const stat = await fs.stat(cachedPath);
      if (stat.isFile()) return cachedPath;
    } catch {
      codexSessionFilePathCache.delete(targetSessionId);
    }
  }

  const findByName = async (dir) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await findByName(fullPath);
          if (found) return found;
        } else if (entry.name.includes(targetSessionId) && entry.name.endsWith('.jsonl')) {
          return fullPath;
        }
      }
    } catch {
      // Skip unreadable directories.
    }
    return null;
  };

  let sessionFilePath = await findByName(codexSessionsDir);
  if (!sessionFilePath) {
    const jsonlFiles = await findCodexJsonlFiles(codexSessionsDir);
    for (const filePath of jsonlFiles) {
      const session = await parseCodexSessionFileFast(filePath);
      if (session?.id === targetSessionId) {
        sessionFilePath = filePath;
        break;
      }
    }
  }

  if (sessionFilePath) {
    codexSessionFilePathCache.set(targetSessionId, sessionFilePath);
  }
  return sessionFilePath;
}

async function resolveCodexSessionFiles(sessionId) {
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const logicalPath = await findCodexSessionFile(codexSessionsDir, sessionId);
  const paths = logicalPath ? [logicalPath] : [];
  const runtimeThreadId = codexRuntimeAliasesDb.get(sessionId);
  if (runtimeThreadId && runtimeThreadId !== sessionId) {
    const runtimePath = await findCodexSessionFile(codexSessionsDir, runtimeThreadId);
    if (runtimePath && !paths.includes(runtimePath)) paths.push(runtimePath);
  }
  return paths;
}

function updateCodexCacheWithParsed(cache, parsed) {
  if (parsed.tokenUsage) {
    const usageTime = Date.parse(String(parsed.tokenUsage.timestamp || '')) || 0;
    if (!cache.tokenUsage || usageTime >= cache.tokenUsageTimestamp) {
      const { timestamp: _timestamp, ...usage } = parsed.tokenUsage;
      cache.tokenUsage = usage;
      cache.tokenUsageTimestamp = usageTime;
    }
  }
  if (!parsed.message) return;
  cache.messageKeys ||= new Set();
  const exactKey = getCodexExactMessageKey(parsed.message);
  if (exactKey && cache.messageKeys.has(exactKey)) return;
  if (exactKey) cache.messageKeys.add(exactKey);
  cache.total += 1;
  const journalKey = getCodexMessageJournalKey(parsed.message);
  if (journalKey) cache.rolloutJournalKeys.add(journalKey);
  cache.tail.push(parsed.message);
  if (cache.tail.length >= cache.capacity * 2) {
    sortCodexMessages(cache.tail);
    cache.tail = cache.tail.slice(-cache.capacity);
  }
}

async function buildCodexPagedCache(sessionId, sessionFilePaths, capacity) {
  const cache = {
    sessionId,
    capacity,
    pathsKey: sessionFilePaths.join('\u0000'),
    files: new Map(),
    tail: [],
    total: 0,
    tokenUsage: null,
    tokenUsageTimestamp: 0,
    rolloutJournalKeys: new Set(),
    messageKeys: new Set(),
  };

  for (const filePath of sessionFilePaths) {
    const scan = await scanCodexFileRange(
      filePath,
      0,
      0,
      sessionId,
      (parsed) => updateCodexCacheWithParsed(cache, parsed),
    );
    const stat = await fs.stat(filePath);
    cache.files.set(filePath, {
      processedSize: scan.processedSize,
      lineNumber: scan.lineNumber,
      observedSize: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  sortCodexMessages(cache.tail);
  cache.tail = cache.tail.slice(-capacity);
  return cache;
}

async function refreshCodexPagedCache(cache, sessionFilePaths) {
  if (cache.pathsKey !== sessionFilePaths.join('\u0000')) return null;

  const stats = new Map();
  for (const filePath of sessionFilePaths) {
    const previous = cache.files.get(filePath);
    if (!previous) return null;
    const stat = await fs.stat(filePath);
    stats.set(filePath, stat);
    if (stat.size < previous.processedSize || stat.size < previous.observedSize) return null;
    if (
      stat.size === previous.processedSize &&
      stat.size === previous.observedSize &&
      stat.mtimeMs !== previous.mtimeMs
    ) {
      return null;
    }
  }

  for (const filePath of sessionFilePaths) {
    const previous = cache.files.get(filePath);
    const stat = stats.get(filePath);
    if (stat.size <= previous.processedSize) continue;
    const scan = await scanCodexFileRange(
      filePath,
      previous.processedSize,
      previous.lineNumber,
      cache.sessionId,
      (parsed) => updateCodexCacheWithParsed(cache, parsed),
    );
    const finalStat = await fs.stat(filePath);
    cache.files.set(filePath, {
      processedSize: scan.processedSize,
      lineNumber: scan.lineNumber,
      observedSize: finalStat.size,
      mtimeMs: finalStat.mtimeMs,
    });
  }

  sortCodexMessages(cache.tail);
  cache.tail = cache.tail.slice(-cache.capacity);
  return cache;
}

function touchCodexPagedCache(sessionId, cache) {
  codexPagedMessageCache.delete(sessionId);
  codexPagedMessageCache.set(sessionId, cache);
  while (codexPagedMessageCache.size > CODEX_PAGED_CACHE_MAX_SESSIONS) {
    const oldest = codexPagedMessageCache.keys().next().value;
    if (oldest === undefined) break;
    codexPagedMessageCache.delete(oldest);
  }
}

function getUniqueCodexJournalMessages(sessionId, rolloutKeys) {
  const keys = new Set(rolloutKeys);
  const journalMessages = [];
  for (const persisted of codexTranscriptDb.getMessages(sessionId)) {
    const key = hashCodexJournalKey(persisted.role, persisted.content);
    if (keys.has(key)) continue;
    keys.add(key);
    const type = persisted.role === 'error'
      ? 'error'
      : persisted.role === 'user' ? 'user' : 'assistant';
    journalMessages.push(type === 'error'
      ? {
          id: `journal:${persisted.id}`,
          type,
          timestamp: persisted.timestamp,
          content: persisted.content,
        }
      : {
          id: `journal:${persisted.id}`,
          type,
          timestamp: persisted.timestamp,
          message: { role: persisted.role, content: persisted.content },
        });
  }
  return journalMessages;
}

function paginateCodexCache(cache, sessionId, limit, offset) {
  const journalMessages = getUniqueCodexJournalMessages(sessionId, cache.rolloutJournalKeys);
  const tail = sortCodexMessages([...cache.tail, ...journalMessages]).slice(-cache.capacity);
  const total = cache.total + journalMessages.length;
  const endIndex = Math.max(0, tail.length - offset);
  const startIndex = Math.max(0, endIndex - limit);
  const messages = tail.slice(startIndex, endIndex);
  return {
    messages,
    total,
    hasMore: total > offset + messages.length,
    offset,
    limit,
    tokenUsage: cache.tokenUsage,
  };
}

async function getPagedCodexSessionMessages(sessionId, limit, offset) {
  const capacity = Math.max(CODEX_PAGED_CACHE_MIN_MESSAGES, limit + offset + 40);
  const activeRefresh = codexPagedMessageRefreshes.get(sessionId);
  if (activeRefresh) await activeRefresh;

  const refresh = (async () => {
    const sessionFilePaths = await resolveCodexSessionFiles(sessionId);
    let cache = codexPagedMessageCache.get(sessionId);
    if (!cache || cache.capacity < capacity) {
      cache = await buildCodexPagedCache(sessionId, sessionFilePaths, capacity);
    } else {
      const refreshed = await refreshCodexPagedCache(cache, sessionFilePaths);
      cache = refreshed || await buildCodexPagedCache(sessionId, sessionFilePaths, capacity);
    }
    touchCodexPagedCache(sessionId, cache);
    return cache;
  })();

  codexPagedMessageRefreshes.set(sessionId, refresh);
  try {
    const cache = await refresh;
    return paginateCodexCache(cache, sessionId, limit, offset);
  } finally {
    if (codexPagedMessageRefreshes.get(sessionId) === refresh) {
      codexPagedMessageRefreshes.delete(sessionId);
    }
  }
}

async function readCompleteCodexSessionMessages(sessionId) {
  const sessionFilePaths = await resolveCodexSessionFiles(sessionId);
  const messages = [];
  let tokenUsage = null;
  let tokenUsageTimestamp = 0;
  const rolloutKeys = new Set();
  const exactMessageKeys = new Set();

  for (const filePath of sessionFilePaths) {
    await scanCodexFileRange(filePath, 0, 0, sessionId, (parsed) => {
      if (parsed.tokenUsage) {
        const usageTime = Date.parse(String(parsed.tokenUsage.timestamp || '')) || 0;
        if (!tokenUsage || usageTime >= tokenUsageTimestamp) {
          const { timestamp: _timestamp, ...usage } = parsed.tokenUsage;
          tokenUsage = usage;
          tokenUsageTimestamp = usageTime;
        }
      }
      if (parsed.message) {
        const exactKey = getCodexExactMessageKey(parsed.message);
        if (exactKey && exactMessageKeys.has(exactKey)) return;
        if (exactKey) exactMessageKeys.add(exactKey);
        messages.push(parsed.message);
        const key = getCodexMessageJournalKey(parsed.message);
        if (key) rolloutKeys.add(key);
      }
    });
  }

  messages.push(...getUniqueCodexJournalMessages(sessionId, rolloutKeys));
  sortCodexMessages(messages);
  return { messages, tokenUsage };
}

// Paged reads keep only a bounded tail and scan newly appended bytes after the
// first request. A 500 MB rollout therefore costs one scan, not one scan per tab
// every four seconds. Complete reads remain available for the explicit Load All
// action and are deduplicated while one is already running.
async function getCodexSessionMessages(sessionId, limit = null, offset = 0) {
  try {
    const normalizedOffset = Math.max(0, Number(offset) || 0);
    const normalizedLimit = limit === null ? null : Math.max(1, Number(limit) || 1);
    if (normalizedLimit !== null) {
      return await getPagedCodexSessionMessages(sessionId, normalizedLimit, normalizedOffset);
    }

    const existingRead = codexCompleteMessageReads.get(sessionId);
    if (existingRead) return await existingRead;
    const read = readCompleteCodexSessionMessages(sessionId);
    codexCompleteMessageReads.set(sessionId, read);
    try {
      return await read;
    } finally {
      if (codexCompleteMessageReads.get(sessionId) === read) {
        codexCompleteMessageReads.delete(sessionId);
      }
    }
  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

async function deleteCodexSession(sessionId) {
  try {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');

    const findJsonlFiles = async (dir) => {
      const files = [];
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...await findJsonlFiles(fullPath));
          } else if (entry.name.endsWith('.jsonl')) {
            files.push(fullPath);
          }
        }
      } catch (error) { }
      return files;
    };

    const jsonlFiles = await findJsonlFiles(codexSessionsDir);

    for (const filePath of jsonlFiles) {
      const sessionData = await parseCodexSessionFile(filePath);
      if (sessionData && sessionData.id === sessionId) {
        await fs.unlink(filePath);
        return true;
      }
    }

    throw new Error(`Codex session file not found for session ${sessionId}`);
  } catch (error) {
    console.error(`Error deleting Codex session ${sessionId}:`, error);
    throw error;
  }
}

export {
  getProjects,
  getSessions,
  getSessionMessages,
  parseJsonlSessions,
  renameProject,
  deleteSession,
  isProjectEmpty,
  deleteProject,
  addProjectManually,
  loadProjectConfig,
  saveProjectConfig,
  extractProjectDirectory,
  clearProjectDirectoryCache,
  getCodexSessions,
  resolveCodexRuntimeThreadId,
  getCodexSessionMessages,
  deleteCodexSession,
  invalidateProjectsCache
};
