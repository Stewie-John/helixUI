import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { TFunction } from 'i18next';
import { api } from '../../../utils/api';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type {
  AdditionalSessionsByProject,
  DeleteProjectConfirmation,
  LoadingSessionsByProject,
  ProjectSortOrder,
  SessionDeleteConfirmation,
  SessionWithProvider,
} from '../types/types';
import {
  filterProjects,
  getAllSessions,
  loadExpandedProjects,
  loadStarredProjects,
  persistExpandedProjects,
  persistStarredProjects,
  readProjectSortOrder,
  sortProjects,
} from '../utils/utils';
import { PROJECTS_REFRESH_REQUESTED_EVENT, SETTINGS_UPDATED_EVENT } from '../../../utils/appEvents';

type UseSidebarControllerArgs = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  isMobile: boolean;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onSessionDelete?: (sessionId: string) => void;
  onProjectDelete?: (projectName: string) => void;
  setCurrentProject: (project: Project) => void;
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
};

export function useSidebarController({
  projects,
  selectedProject,
  selectedSession,
  isLoading,
  isMobile,
  t,
  onRefresh,
  onProjectSelect,
  onSessionSelect,
  onSessionDelete,
  onProjectDelete,
  setCurrentProject,
  setSidebarVisible,
  sidebarVisible,
}: UseSidebarControllerArgs) {
  // 从 sessionStorage 恢复本标签页上次的展开/折叠状态（刷新后保留）
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => loadExpandedProjects());
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [loadingSessions, setLoadingSessions] = useState<LoadingSessionsByProject>({});
  const [additionalSessions, setAdditionalSessions] = useState<AdditionalSessionsByProject>({});
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [projectHasMoreOverrides, setProjectHasMoreOverrides] = useState<Record<string, boolean>>({});
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteProjectConfirmation | null>(null);
  const [sessionDeleteConfirmation, setSessionDeleteConfirmation] = useState<SessionDeleteConfirmation | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [starredProjects, setStarredProjects] = useState<Set<string>>(() => loadStarredProjects());
  const [continuationVersion, setContinuationVersion] = useState(0);

  const isSidebarCollapsed = !isMobile && !sidebarVisible;

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleContinuationUpdate = () => {
      setContinuationVersion((version) => version + 1);
    };

    window.addEventListener('compact-continuation-updated', handleContinuationUpdate);
    return () => window.removeEventListener('compact-continuation-updated', handleContinuationUpdate);
  }, []);

  // 追踪上一次的项目名称集合，用于判断项目是否被删除
  const prevProjectNamesRef = useRef<Set<string>>(new Set());

  // 当 projects 更新时：
  // 1. 只有在项目被删除时才重置 additionalSessions（防止 WebSocket 频繁推送导致 show-more 加载的会话被清除）
  // 2. initialSessionsLoaded 仅在内容真正变化时才更新（避免不必要的 re-render 和 skeleton 闪烁）
  useEffect(() => {
    const currentNames = new Set(projects.map((p) => p.name));
    const prevNames = prevProjectNamesRef.current;

    // 检测是否有项目被删除
    const hasRemovedProjects = [...prevNames].some((name) => !currentNames.has(name));
    if (hasRemovedProjects || prevNames.size === 0) {
      // 只在首次加载或项目被删除时重置额外加载的会话
      setAdditionalSessions({});
      setProjectHasMoreOverrides({});
    }
    prevProjectNamesRef.current = currentNames;

    if (projects.length > 0 && !isLoading) {
      // 用函数式更新避免 Set 引用变化导致的无效 re-render
      setInitialSessionsLoaded((prev) => {
        const loadedProjects = new Set<string>();
        projects.forEach((project) => {
          if (project.sessions && project.sessions.length >= 0) {
            loadedProjects.add(project.name);
          }
        });
        // 内容相同则返回 prev，不触发 re-render
        if (prev.size === loadedProjects.size && [...loadedProjects].every((name) => prev.has(name))) {
          return prev;
        }
        return loadedProjects;
      });
    } else {
      setInitialSessionsLoaded((prev) => (prev.size === 0 ? prev : new Set()));
    }
  }, [projects, isLoading]);

  // 展开/折叠状态变化时写回 sessionStorage（本标签页独立记忆）
  useEffect(() => {
    persistExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  // The project containing the visible conversation must always be discoverable
  // after a refresh or in a newly opened tab. Apply this only when the selected
  // project changes, so the user can still manually collapse it afterwards.
  useEffect(() => {
    const projectName = selectedProject?.name;
    if (!projectName) return;
    setExpandedProjects((previous) => {
      if (previous.has(projectName)) return previous;
      const next = new Set(previous);
      next.add(projectName);
      return next;
    });
  }, [selectedProject?.name]);

  useEffect(() => {
    const loadSortOrder = () => {
      setProjectSortOrder(readProjectSortOrder());
    };

    loadSortOrder();

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'claude-settings') {
        loadSortOrder();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener(SETTINGS_UPDATED_EVENT, loadSortOrder);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(SETTINGS_UPDATED_EVENT, loadSortOrder);
    };
  }, []);

  const handleTouchClick = useCallback(
    (callback: () => void) =>
      (event: React.TouchEvent<HTMLElement>) => {
        const target = event.target as HTMLElement;
        if (target.closest('.overflow-y-auto') || target.closest('[data-scroll-container]')) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        callback();
      },
    [],
  );

  // 独立开关（而非手风琴）：点击谁就切换谁的展开/折叠，其它文件夹的状态保持不变。
  // 这样才能「记住哪里折叠、哪里展开」的任意组合，并整组持久化到 sessionStorage。
  const toggleProject = useCallback((projectName: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectName)) {
        next.delete(projectName);
      } else {
        next.add(projectName);
      }
      return next;
    });
  }, []);

  const handleSessionClick = useCallback(
    (session: SessionWithProvider, projectName: string) => {
      onSessionSelect({ ...session, __projectName: projectName });
    },
    [onSessionSelect],
  );

  const toggleStarProject = useCallback((projectName: string) => {
    setStarredProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectName)) {
        next.delete(projectName);
      } else {
        next.add(projectName);
      }

      persistStarredProjects(next);
      return next;
    });
  }, []);

  const isProjectStarred = useCallback(
    (projectName: string) => starredProjects.has(projectName),
    [starredProjects],
  );

  // per-project 的 session 列表缓存为「稳定引用」：依赖不变时返回同一数组，
  // 避免每次渲染都重算 + 重新排序，从而消除列表闪动/跳序。
  // 同时把「当前选中的会话」强制注入它所属项目——防止该会话因服务端分页
  // （只返回最新 5 个）或排序停留在旧时间戳而被挤到 show-more 之后看不见。
  const projectSessionsMap = useMemo(() => {
    const map = new Map<string, SessionWithProvider[]>();
    for (const project of projects) {
      let sessions = getAllSessions(project, additionalSessions);
      if (
        selectedSession?.id &&
        selectedProject?.name === project.name &&
        !sessions.some((session) => session.id === selectedSession.id)
      ) {
        const provider =
          ((selectedSession as { __provider?: SessionWithProvider['__provider'] }).__provider) || 'claude';
        // 注入时把 lastActivity 置为当前时间，确保当前正在使用的对话排在最上面
        const injected = {
          ...(selectedSession as unknown as SessionWithProvider),
          __provider: provider,
          lastActivity: new Date().toISOString(),
        } as SessionWithProvider;
        sessions = [injected, ...sessions];
      }
      map.set(project.name, sessions);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, additionalSessions, continuationVersion, selectedSession, selectedProject]);

  const getProjectSessions = useCallback(
    (project: Project) =>
      projectSessionsMap.get(project.name) ?? getAllSessions(project, additionalSessions),
    [projectSessionsMap, additionalSessions],
  );

  const projectsWithSessionMeta = useMemo(
    () =>
      projects.map((project) => {
        const hasMoreOverride = projectHasMoreOverrides[project.name];
        const loadedClaudeSessionCount = new Set([
          ...(project.sessions || []),
          ...(additionalSessions[project.name] || []),
        ].map((session) => session.id)).size;
        const declaredSessionTotal = Number(project.sessionMeta?.total || 0);
        const hasKnownMissingSessions = declaredSessionTotal > loadedClaudeSessionCount;
        const hasMore =
          hasKnownMissingSessions ||
          (hasMoreOverride !== undefined ? hasMoreOverride : project.sessionMeta?.hasMore === true);

        return {
          ...project,
          sessionMeta: { ...project.sessionMeta, hasMore },
        };
      }),
    [additionalSessions, projectHasMoreOverrides, projects],
  );

  const sortedProjects = useMemo(
    () => sortProjects(projectsWithSessionMeta, projectSortOrder, starredProjects, additionalSessions),
    [additionalSessions, projectSortOrder, projectsWithSessionMeta, starredProjects],
  );

  const filteredProjects = useMemo(
    () => filterProjects(sortedProjects, searchFilter),
    [searchFilter, sortedProjects],
  );

  const startEditing = useCallback((project: Project) => {
    setEditingProject(project.name);
    setEditingName(project.displayName);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingProject(null);
    setEditingName('');
  }, []);

  const saveProjectName = useCallback(
    async (projectName: string) => {
      try {
        const response = await api.renameProject(projectName, editingName);
        if (response.ok) {
          if (window.refreshProjects) {
            await window.refreshProjects();
          } else {
            window.dispatchEvent(new Event(PROJECTS_REFRESH_REQUESTED_EVENT));
          }
        } else {
          console.error('Failed to rename project');
        }
      } catch (error) {
        console.error('Error renaming project:', error);
      } finally {
        setEditingProject(null);
        setEditingName('');
      }
    },
    [editingName],
  );

  const showDeleteSessionConfirmation = useCallback(
    (
      projectName: string,
      sessionId: string,
      sessionTitle: string,
      provider: SessionDeleteConfirmation['provider'] = 'claude',
    ) => {
      setSessionDeleteConfirmation({ projectName, sessionId, sessionTitle, provider });
    },
    [],
  );

  const confirmDeleteSession = useCallback(async () => {
    if (!sessionDeleteConfirmation) {
      return;
    }

    const { projectName, sessionId, provider } = sessionDeleteConfirmation;
    setSessionDeleteConfirmation(null);

    // Remove the card immediately from both the initial project payload and
    // locally paginated "show more" sessions. Waiting for disk I/O made delete
    // feel unresponsive, and filtering only the parent payload left paginated
    // cards visible even after the server had deleted them.
    onSessionDelete?.(sessionId);
    setAdditionalSessions((prev) => ({
      ...prev,
      [projectName]: (prev[projectName] || []).filter((session) => session.id !== sessionId),
    }));

    try {
      let response;
      if (provider === 'codex') {
        response = await api.deleteCodexSession(sessionId);
      } else if (provider === 'gemini') {
        response = await api.deleteGeminiSession(sessionId);
      } else {
        response = await api.deleteSession(projectName, sessionId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to delete session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.deleteSessionFailed'));
        await onRefresh();
      }
    } catch (error) {
      console.error('[Sidebar] Error deleting session:', error);
      alert(t('messages.deleteSessionError'));
      await onRefresh();
    }
  }, [onRefresh, onSessionDelete, sessionDeleteConfirmation, t]);

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setDeleteConfirmation({
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
  );

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteConfirmation) {
      return;
    }

    const { project, sessionCount } = deleteConfirmation;
    const isEmpty = sessionCount === 0;

    setDeleteConfirmation(null);
    setDeletingProjects((prev) => new Set([...prev, project.name]));

    try {
      const response = await api.deleteProject(project.name, !isEmpty);

      if (response.ok) {
        onProjectDelete?.(project.name);
      } else {
        const error = (await response.json()) as { error?: string };
        alert(error.error || t('messages.deleteProjectFailed'));
      }
    } catch (error) {
      console.error('Error deleting project:', error);
      alert(t('messages.deleteProjectError'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.name);
        return next;
      });
    }
  }, [deleteConfirmation, onProjectDelete, t]);

  const loadMoreSessions = useCallback(
    async (project: Project) => {
      const hasMoreOverride = projectHasMoreOverrides[project.name];
      const existingAdditionalSessions = additionalSessions[project.name] || [];
      const loadedClaudeSessionIds = new Set([
        ...(project.sessions || []),
        ...existingAdditionalSessions,
      ].map((session) => session.id));
      const declaredSessionTotal = Number(project.sessionMeta?.total || 0);
      const hasKnownMissingSessions = declaredSessionTotal > loadedClaudeSessionIds.size;
      const canLoadMore =
        hasKnownMissingSessions ||
        (hasMoreOverride !== undefined ? hasMoreOverride : project.sessionMeta?.hasMore === true);
      if (!canLoadMore || loadingSessions[project.name]) {
        return;
      }

      setLoadingSessions((prev) => ({ ...prev, [project.name]: true }));

      try {
        const currentSessionCount = loadedClaudeSessionIds.size;
        const response = await api.sessions(project.name, 5, currentSessionCount);

        if (!response.ok) {
          return;
        }

        const result = (await response.json()) as {
          sessions?: ProjectSession[];
          hasMore?: boolean;
          total?: number;
        };

        const additions = (result.sessions || []).filter(
          (session) => !loadedClaudeSessionIds.has(session.id),
        );

        setAdditionalSessions((prev) => {
          const existing = prev[project.name] || [];
          const knownIds = new Set((project.sessions || []).map((session) => session.id));
          const uniqueAdditions = additions.filter((session) => !knownIds.has(session.id));
          return {
            ...prev,
            [project.name]: [...existing, ...uniqueAdditions],
          };
        });

        const resultTotal = Number(result.total ?? declaredSessionTotal);
        const loadedAfterRequest = loadedClaudeSessionIds.size + additions.length;
        const stillHasMore = result.hasMore === true || resultTotal > loadedAfterRequest;
        // Keep hasMore state in local hook state instead of mutating the project prop object.
        setProjectHasMoreOverrides((prev) => ({ ...prev, [project.name]: stillHasMore }));
      } catch (error) {
        console.error('Error loading more sessions:', error);
      } finally {
        setLoadingSessions((prev) => ({ ...prev, [project.name]: false }));
      }
    },
    [additionalSessions, loadingSessions, projectHasMoreOverrides],
  );

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
      setCurrentProject(project);
    },
    [onProjectSelect, setCurrentProject],
  );

  const refreshProjects = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  const updateSessionSummary = useCallback(
    async (_projectName: string, sessionId: string, summary: string, provider: SessionProvider) => {
      const trimmed = summary.trim();
      if (!trimmed) {
        setEditingSession(null);
        setEditingSessionName('');
        return;
      }
      try {
        const response = await api.renameSession(sessionId, trimmed, provider);
        if (response.ok) {
          await onRefresh();
        } else {
          console.error('[Sidebar] Failed to rename session:', response.status);
          alert(t('messages.renameSessionFailed'));
        }
      } catch (error) {
        console.error('[Sidebar] Error renaming session:', error);
        alert(t('messages.renameSessionError'));
      } finally {
        setEditingSession(null);
        setEditingSessionName('');
      }
    },
    [onRefresh, t],
  );

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  return {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    loadingSessions,
    additionalSessions,
    initialSessionsLoaded,
    currentTime,
    projectSortOrder,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    deletingProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    starredProjects,
    filteredProjects,
    handleTouchClick,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    loadMoreSessions,
    handleProjectSelect,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar,
    expandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
  };
}
