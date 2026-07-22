import type { TFunction } from 'i18next';
import type { Project } from '../../../types/app';
import type {
  AdditionalSessionsByProject,
  ProjectSortOrder,
  SettingsProject,
  SessionViewModel,
  SessionWithProvider,
} from '../types/types';
import {
  getCompactContinuationAliasMap,
  getCanonicalCompactContinuationSource,
  getCompactContinuationHiddenSessionIds,
  getCompactContinuationProjectMap,
  getManuallyAbsorbedContinuationSessionIds,
  repairCompactContinuationChainForProject,
} from '../../chat/utils/compactContinuations';

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return 'name';
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return settings.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

export const loadStarredProjects = (): Set<string> => {
  try {
    const saved = localStorage.getItem('starredProjects');
    return saved ? new Set<string>(JSON.parse(saved)) : new Set<string>();
  } catch {
    return new Set<string>();
  }
};

export const persistStarredProjects = (starredProjects: Set<string>) => {
  try {
    localStorage.setItem('starredProjects', JSON.stringify([...starredProjects]));
  } catch {
    // Keep UI responsive even if storage fails.
  }
};

// 侧边栏展开/折叠状态：用 sessionStorage 而非 localStorage，
// 这样每个浏览器标签页各自记忆自己的展开/折叠状态（sessionStorage 标签页隔离），
// 同一标签页刷新后保留当前状态，不同标签页互不影响。
const EXPANDED_PROJECTS_STORAGE_KEY = 'sidebar-expanded-projects';

export const loadExpandedProjects = (): Set<string> => {
  try {
    if (typeof window === 'undefined') return new Set<string>();
    const saved = sessionStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY);
    return saved ? new Set<string>(JSON.parse(saved)) : new Set<string>();
  } catch {
    return new Set<string>();
  }
};

export const persistExpandedProjects = (expandedProjects: Set<string>) => {
  try {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify([...expandedProjects]));
  } catch {
    // Keep UI responsive even if storage fails.
  }
};

export const getSessionDate = (session: SessionWithProvider): Date => {
  if (session.__provider === 'cursor') {
    return new Date(session.createdAt || 0);
  }

  if (session.__provider === 'codex') {
    return new Date(session.lastActivity || session.updated_at || session.createdAt || 0);
  }

  return new Date(session.lastActivity || session.createdAt || 0);
};

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  if (session.__provider === 'cursor') {
    return session.summary || session.name || t('projects.untitledSession');
  }

  if (session.__provider === 'codex') {
    return session.summary || session.name || t('projects.codexSession');
  }

  if (session.__provider === 'gemini') {
    return session.summary || session.name || t('projects.newSession');
  }

  return session.summary || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  if (session.__provider === 'cursor') {
    return String(session.createdAt || '');
  }

  if (session.__provider === 'codex') {
    return String(session.lastActivity || session.updated_at || session.createdAt || '');
  }

  return String(session.lastActivity || session.createdAt || '');
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isCursorSession: session.__provider === 'cursor',
    isCodexSession: session.__provider === 'codex',
    isGeminiSession: session.__provider === 'gemini',
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

export const getAllSessions = (
  project: Project,
  additionalSessions: AdditionalSessionsByProject,
): SessionWithProvider[] => {
  const decorate = (session: any, __provider: SessionWithProvider['__provider']): SessionWithProvider => ({
    ...session,
    __provider,
  });
  const rawSessions = [
    ...(project.sessions || []).map((session) => decorate(session, 'claude')),
    ...(additionalSessions[project.name] || []).map((session) => decorate(session, 'claude')),
    ...(project.cursorSessions || []).map((session) => decorate(session, 'cursor')),
    ...(project.codexSessions || []).map((session) => decorate(session, 'codex')),
    ...(project.geminiSessions || []).map((session) => decorate(session, 'gemini')),
  ];

  // Keep the authoritative project entry when a stale "load more" copy has the
  // same provider and id. The stale copy may not include the session metadata
  // needed to restore its title and transcript.
  const seenSessionKeys = new Set<string>();
  const allSessions = rawSessions.filter((session) => {
    const key = `${session.__provider}:${session.id}`;
    if (seenSessionKeys.has(key)) return false;
    seenSessionKeys.add(key);
    return true;
  });

  repairCompactContinuationChainForProject(project.name, allSessions);

  const aliases = getCompactContinuationAliasMap();
  const globallyHiddenContinuationIds = getCompactContinuationHiddenSessionIds();
  const manuallyAbsorbedContinuationIds = getManuallyAbsorbedContinuationSessionIds();
  const continuationProjects = getCompactContinuationProjectMap();
  const allSessionsById = new Map<string, SessionWithProvider>();
  allSessions.forEach((session) => {
    allSessionsById.set(session.id, session);
  });

  const hiddenContinuationIds = new Set(
    [
      ...Array.from(manuallyAbsorbedContinuationIds).filter((sessionId) => allSessionsById.has(sessionId)),
      ...Object.entries(aliases)
      .filter(([visibleSessionId, continuationSessionId]) =>
        getCanonicalCompactContinuationSource(aliases, continuationSessionId) === visibleSessionId &&
        globallyHiddenContinuationIds.has(continuationSessionId) &&
        allSessionsById.has(continuationSessionId) &&
        (
          !continuationProjects[continuationSessionId] ||
          continuationProjects[visibleSessionId] === project.name ||
          continuationProjects[continuationSessionId] === project.name
        )
      )
      .map(([, continuationSessionId]) => continuationSessionId),
    ],
  );

  const mergeContinuationActivity = (session: SessionWithProvider): SessionWithProvider => {
    const continuationSessionId = aliases[session.id];
    if (
      !continuationSessionId ||
      getCanonicalCompactContinuationSource(aliases, continuationSessionId) !== session.id ||
      (continuationProjects[session.id] && continuationProjects[session.id] !== project.name) ||
      (continuationProjects[continuationSessionId] && continuationProjects[continuationSessionId] !== project.name)
    ) {
      return session;
    }

    const continuation = allSessionsById.get(continuationSessionId);
    if (!continuation) return session;

    const sessionDate = getSessionDate(session);
    const continuationDate = getSessionDate(continuation);
    if (continuationDate <= sessionDate) return session;

    return {
      ...session,
      lastActivity: continuation.lastActivity || continuation.updated_at || continuation.createdAt || session.lastActivity,
      updated_at: continuation.updated_at || session.updated_at,
      messageCount: Math.max(
        Number(session.messageCount || 0),
        Number(continuation.messageCount || 0),
      ),
    };
  };

  const claudeSessions = allSessions
    .filter((session) => session.__provider === 'claude')
    .filter((session) => !hiddenContinuationIds.has(session.id))
    .map(mergeContinuationActivity);

  const cursorSessions = allSessions
    .filter((session) => session.__provider === 'cursor')
    .filter((session) => !hiddenContinuationIds.has(session.id))
    .map(mergeContinuationActivity);

  const codexSessions = allSessions
    .filter((session) => session.__provider === 'codex')
    .filter((session) => !hiddenContinuationIds.has(session.id))
    .map(mergeContinuationActivity);

  const geminiSessions = allSessions
    .filter((session) => session.__provider === 'gemini')
    .filter((session) => !hiddenContinuationIds.has(session.id))
    .map(mergeContinuationActivity);

  // A refreshed primary page can overlap with the locally cached "show more"
  // page. Keep the first occurrence (the fresh primary record) so one session
  // never renders as a stack of identical sidebar rows.
  return [...claudeSessions, ...cursorSessions, ...codexSessions, ...geminiSessions].sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );
};

export const getProjectLastActivity = (
  project: Project,
  additionalSessions: AdditionalSessionsByProject,
): Date => {
  const sessions = getAllSessions(project, additionalSessions);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
  starredProjects: Set<string>,
  additionalSessions: AdditionalSessionsByProject,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    const aStarred = starredProjects.has(projectA.name);
    const bStarred = starredProjects.has(projectB.name);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return (
        getProjectLastActivity(projectB, additionalSessions).getTime() -
        getProjectLastActivity(projectA, additionalSessions).getTime()
      );
    }

    return (projectA.displayName || projectA.name).localeCompare(projectB.displayName || projectB.name);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.name).toLowerCase();
    const projectName = project.name.toLowerCase();
    return displayName.includes(normalizedSearch) || projectName.includes(normalizedSearch);
  });
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  return {
    name: project.name,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.name,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
