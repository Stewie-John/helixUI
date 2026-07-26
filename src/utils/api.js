import { IS_PLATFORM } from "../constants/config";

export const AUTH_TOKEN_INVALID_EVENT = 'cloudcli-auth-token-invalid';

const notifyInvalidAuthToken = () => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('auth-token');
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_INVALID_EVENT));
};

// Utility function for authenticated API calls
export const authenticatedFetch = async (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  });

  // A normal 403 means the signed-in user lacks permission for this operation;
  // it must never erase a valid login. The auth middleware marks only actual
  // bearer-token failures with this response header.
  if (!IS_PLATFORM && token && response.headers.get('x-auth-token-invalid') === '1') {
    notifyInvalidAuthToken();
  }

  return response;
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password, setupToken) => fetch('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(setupToken ? { 'X-Setup-Token': setupToken } : {}),
      },
      body: JSON.stringify({ username, password }),
    }),
    // 管理员创建账号：复用 /register，但走 authenticatedFetch 自动带上 admin 的 bearer token
    createUser: (username, password) =>
      authenticatedFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),
    changePassword: (currentPassword, newPassword) =>
      authenticatedFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    revokeOtherSessions: () =>
      authenticatedFetch('/api/auth/revoke-other-sessions', { method: 'POST' }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  projects: (options = {}) => authenticatedFetch('/api/projects', options),
  sessions: (projectName, limit = 5, offset = 0) =>
    authenticatedFetch(`/api/projects/${projectName}/sessions?limit=${limit}&offset=${offset}`),
  sessionMessages: (projectName, sessionId, limit = null, offset = 0, provider = 'claude', requestOptions = {}) => {
    const { fullTranscript = false, ...fetchOptions } = requestOptions;
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', limit);
      params.append('offset', offset);
    } else if (fullTranscript) {
      params.append('full', '1');
    }
    const queryString = params.toString();

    let url;
    if (provider === 'codex') {
      url = `/api/codex/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else if (provider === 'cursor') {
      url = `/api/cursor/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else if (provider === 'gemini') {
      url = `/api/gemini/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else {
      url = `/api/projects/${projectName}/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    }
    return authenticatedFetch(url, fetchOptions);
  },
  renameProject: (projectName, displayName) =>
    authenticatedFetch(`/api/projects/${projectName}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  deleteSession: (projectName, sessionId) =>
    authenticatedFetch(`/api/projects/${projectName}/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  renameSession: (sessionId, summary, provider) =>
    authenticatedFetch(`/api/sessions/${sessionId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ summary, provider }),
    }),
  deleteCodexSession: (sessionId) =>
    authenticatedFetch(`/api/codex/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteGeminiSession: (sessionId) =>
    authenticatedFetch(`/api/gemini/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteProject: (projectName, force = false) =>
    authenticatedFetch(`/api/projects/${projectName}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),
  createProject: (path) =>
    authenticatedFetch('/api/projects/create', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  createWorkspace: (workspaceData) =>
    authenticatedFetch('/api/projects/create-workspace', {
      method: 'POST',
      body: JSON.stringify(workspaceData),
    }),
  readFile: (projectName, filePath) =>
    authenticatedFetch(`/api/projects/${projectName}/file?filePath=${encodeURIComponent(filePath)}`),
  // 二进制流式读取（PDF / 图片 / 二进制等）：服务器按文件实际 MIME 类型直传 raw bytes，
  // 不经 utf8 解码 / JSON 包装，避免文本端点把二进制损坏（PDF 打开空白即此原因）。
  downloadFile: (projectName, filePath) =>
    authenticatedFetch(`/api/projects/${projectName}/files/content?path=${encodeURIComponent(filePath)}`),
  saveFile: (projectName, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectName}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectName, options = {}) =>
    authenticatedFetch(`/api/projects/${projectName}/files?depth=0`, options),
  getMentionFiles: (projectName, options = {}) =>
    authenticatedFetch(`/api/projects/${projectName}/files?depth=3`, options),
  getFilesAtPath: (projectName, dirPath, options = {}) =>
    authenticatedFetch(`/api/projects/${projectName}/files?depth=0&path=${encodeURIComponent(dirPath)}`, options),
  searchFiles: (projectName, query, options = {}) =>
    authenticatedFetch(`/api/projects/${projectName}/files?search=${encodeURIComponent(query)}`, options),

  // File operations
  createFile: (projectName, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectName, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  moveFile: (projectName, { sourcePath, targetDir }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/move`, {
      method: 'PUT',
      body: JSON.stringify({ sourcePath, targetDir }),
    }),

  deleteFile: (projectName, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectName}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectName, formData) =>
    authenticatedFetch(`/api/projects/${projectName}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  transcribe: (formData) =>
    authenticatedFetch('/api/transcribe', {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // TaskMaster endpoints
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectName) =>
      authenticatedFetch(`/api/taskmaster/init/${projectName}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectName, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectName, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectName, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectName, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectName}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
    uploadAvatar: (avatarUrl) =>
      authenticatedFetch('/api/user/avatar', {
        method: 'POST',
        body: JSON.stringify({ avatar_url: avatarUrl }),
      }),
    removeAvatar: () =>
      authenticatedFetch('/api/user/avatar', { method: 'DELETE' }),
    listAvatars: () => authenticatedFetch('/api/user/avatars'),
  },

  // 消息归属（多账号共享数据时按 user 区分头像）
  attributions: {
    getBySession: (sessionId) =>
      authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/attributions`),
  },

  // 会话子文件夹（多层嵌套，仅前端视图层归类，不动 ~/.claude/projects 下的会话文件）
  folders: {
    list: (projectName) =>
      authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/folders`),
    create: (projectName, payload) =>
      authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/folders`, {
        method: 'POST',
        body: JSON.stringify({ name: payload?.name, parent_id: payload?.parent_id ?? null }),
      }),
    update: (projectName, folderId, patch) =>
      authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/folders/${folderId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    contentsCount: (projectName, folderId) =>
      authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/folders/${folderId}/contents-count`,
      ),
    remove: (projectName, folderId) =>
      authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/folders/${folderId}`, {
        method: 'DELETE',
      }),
    moveSession: (sessionId, { projectName, provider, folderId }) =>
      authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/folder`, {
        method: 'PUT',
        body: JSON.stringify({ project_name: projectName, provider, folder_id: folderId }),
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
