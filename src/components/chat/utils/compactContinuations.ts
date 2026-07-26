import type { Project, SessionProvider } from '../../../types/app';

// V1 inferred continuation chains from timestamps and project membership. Two
// independent conversations in the same directory could therefore be joined.
// Use a new namespace so those unverifiable aliases cannot affect routing.
const CONTINUATION_STORAGE_VERSION = 'v2';
const HIDDEN_SESSION_IDS_KEY = `compactContinuationHiddenSessionIds:${CONTINUATION_STORAGE_VERSION}`;
const SESSION_ALIASES_KEY = `compactContinuationSessionAliases:${CONTINUATION_STORAGE_VERSION}`;
const SESSION_PROVIDERS_KEY = `compactContinuationSessionProviders:${CONTINUATION_STORAGE_VERSION}`;
const SESSION_PROJECTS_KEY = `compactContinuationSessionProjects:${CONTINUATION_STORAGE_VERSION}`;

const canUseLocalStorage = () => typeof window !== 'undefined' && Boolean(window.localStorage);

const readStringArray = (key: string): string[] => {
  if (!canUseLocalStorage()) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

const writeStringArray = (key: string, values: string[]) => {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(new Set(values))));
  } catch {
    // ignore storage failures
  }
};

const readAliases = (): Record<string, string> => {
  if (!canUseLocalStorage()) return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_ALIASES_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
};

const writeAliases = (aliases: Record<string, string>) => {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(SESSION_ALIASES_KEY, JSON.stringify(aliases));
  } catch {
    // ignore storage failures
  }
};

export const getCompactContinuationAliasMap = (): Record<string, string> => readAliases();

export const getCanonicalCompactContinuationSource = (
  aliases: Record<string, string>,
  continuationSessionId: string | null | undefined,
): string | null => {
  if (!continuationSessionId) return null;
  for (const [visibleSessionId, aliasTargetId] of Object.entries(aliases)) {
    if (aliasTargetId === continuationSessionId) {
      return visibleSessionId;
    }
  }
  return null;
};

const readProviders = (): Record<string, string> => {
  if (!canUseLocalStorage()) return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_PROVIDERS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
};

const writeProviders = (providers: Record<string, string>) => {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(SESSION_PROVIDERS_KEY, JSON.stringify(providers));
  } catch {
    // ignore storage failures
  }
};

const readProjects = (): Record<string, string> => {
  if (!canUseLocalStorage()) return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_PROJECTS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
};

const writeProjects = (projects: Record<string, string>) => {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(SESSION_PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    // ignore storage failures
  }
};

export const getCompactContinuationProjectMap = (): Record<string, string> => readProjects();

const getProjectName = (project: Project | null | undefined): string | null =>
  typeof project?.name === 'string' && project.name ? project.name : null;

const isSessionProjectCompatible = (
  project: Project | null | undefined,
  sessionId: string | null | undefined,
  projects: Record<string, string>,
): boolean => {
  if (!sessionId) return false;
  const projectName = getProjectName(project);
  const mappedProjectName = projects[sessionId];
  return !projectName || !mappedProjectName || mappedProjectName === projectName;
};

export const getCompactContinuationHiddenSessionIds = (): Set<string> => {
  return new Set(readStringArray(HIDDEN_SESSION_IDS_KEY));
};

export const getManuallyAbsorbedContinuationSessionIds = (): Set<string> =>
  new Set<string>();

type CompactContinuationSessionLike = {
  id?: string | null;
  name?: string | null;
  summary?: string | null;
  lastActivity?: string | number | Date | null;
  updated_at?: string | number | Date | null;
  createdAt?: string | number | Date | null;
  __provider?: string | null;
  provider?: string | null;
  isCompactContinuation?: boolean | null;
};

export const repairCompactContinuationChainForProject = (
  _projectName: string | null | undefined,
  _sessions: CompactContinuationSessionLike[],
): boolean => {
  // Continuation identity is a routing decision, so it must come from the
  // explicit session-created flow. Project membership, timestamps, titles and
  // provider names are not sufficient evidence and must never create aliases.
  return false;
};

export const rememberCompactContinuationSession = (
  visibleSessionId: string | null | undefined,
  continuationSessionId: string | null | undefined,
  provider?: string | null,
  projectName?: string | null,
) => {
  if (!visibleSessionId || !continuationSessionId || visibleSessionId === continuationSessionId) return;

  writeStringArray(HIDDEN_SESSION_IDS_KEY, [
    ...readStringArray(HIDDEN_SESSION_IDS_KEY),
    continuationSessionId,
  ]);

  const aliases = readAliases();
  for (const [aliasSourceId, aliasTargetId] of Object.entries(aliases)) {
    if (aliasSourceId !== visibleSessionId && aliasTargetId === continuationSessionId) {
      delete aliases[aliasSourceId];
    }
  }
  aliases[visibleSessionId] = continuationSessionId;
  writeAliases(aliases);

  if (provider) {
    const providers = readProviders();
    providers[visibleSessionId] = provider;
    providers[continuationSessionId] = provider;
    writeProviders(providers);
  }

  if (projectName) {
    const projects = readProjects();
    projects[visibleSessionId] = projectName;
    projects[continuationSessionId] = projectName;
    writeProjects(projects);
  }

  try {
    window.dispatchEvent(new CustomEvent('compact-continuation-updated', {
      detail: {
        visibleSessionId,
        continuationSessionId,
        provider,
        projectName,
      },
    }));
  } catch {
    // ignore event failures
  }
};

export const resolveCompactContinuationSessionId = (sessionId: string | null | undefined): string | null => {
  if (!sessionId) return null;

  const aliases = readAliases();
  const seen = new Set<string>();
  let current = sessionId;

  for (let i = 0; i < 10; i += 1) {
    const next = aliases[current];
    if (!next || seen.has(next)) break;
    seen.add(current);
    current = next;
  }

  return current;
};

export const resolveCompactContinuationInfo = (
  sessionId: string | null | undefined,
): { sessionId: string | null; provider: string | null; isContinuation: boolean } => {
  if (!sessionId) {
    return { sessionId: null, provider: null, isContinuation: false };
  }

  const resolvedSessionId = resolveCompactContinuationSessionId(sessionId);
  const providers = readProviders();
  const provider = providers[sessionId] || (resolvedSessionId ? providers[resolvedSessionId] : null) || null;

  return {
    sessionId: resolvedSessionId,
    provider,
    isContinuation: Boolean(resolvedSessionId && resolvedSessionId !== sessionId),
  };
};

export const getProjectSessionProvider = (
  project: Project | null | undefined,
  sessionId: string | null | undefined,
): SessionProvider | null => {
  if (!project || !sessionId) return null;

  const sessionGroups: Array<[SessionProvider, unknown]> = [
    ['claude', project.sessions],
    ['cursor', project.cursorSessions],
    ['codex', project.codexSessions],
    ['gemini', project.geminiSessions],
  ];

  for (const [provider, sessions] of sessionGroups) {
    if (Array.isArray(sessions) && sessions.some((session) => session?.id === sessionId)) {
      return provider;
    }
  }

  return null;
};

export const resolveCompactContinuationInfoForProject = (
  project: Project | null | undefined,
  sessionId: string | null | undefined,
): { sessionId: string | null; provider: SessionProvider | string | null; isContinuation: boolean } => {
  if (!sessionId) {
    return { sessionId: null, provider: null, isContinuation: false };
  }

  const originalProvider = getProjectSessionProvider(project, sessionId);
  const info = resolveCompactContinuationInfo(sessionId);
  if (!info.isContinuation || !info.sessionId) {
    return {
      sessionId,
      provider: originalProvider || info.provider,
      isContinuation: false,
    };
  }

  const aliases = readAliases();
  const projects = readProjects();
  if (
    !isSessionProjectCompatible(project, sessionId, projects) ||
    !isSessionProjectCompatible(project, info.sessionId, projects)
  ) {
    return {
      sessionId,
      provider: originalProvider,
      isContinuation: false,
    };
  }

  const canonicalSourceSessionId = getCanonicalCompactContinuationSource(aliases, info.sessionId);
  if (canonicalSourceSessionId && canonicalSourceSessionId !== sessionId) {
    return {
      sessionId,
      provider: originalProvider,
      isContinuation: false,
    };
  }

  const continuationProvider = getProjectSessionProvider(project, info.sessionId);
  if (!continuationProvider) {
    return {
      sessionId,
      provider: originalProvider,
      isContinuation: false,
    };
  }

  return {
    sessionId: info.sessionId,
    provider: continuationProvider,
    isContinuation: true,
  };
};

export const resolveCompactContinuationChainForProject = (
  project: Project | null | undefined,
  sessionId: string | null | undefined,
): Array<{ sessionId: string; provider: SessionProvider | string }> => {
  if (!sessionId) return [];

  const aliases = readAliases();
  const projects = readProjects();
  const chain: Array<{ sessionId: string; provider: SessionProvider | string }> = [];
  const seen = new Set<string>([sessionId]);
  let currentSessionId = sessionId;

  for (let index = 0; index < 10; index += 1) {
    const nextSessionId = aliases[currentSessionId];
    if (!nextSessionId || seen.has(nextSessionId)) break;
    if (
      !isSessionProjectCompatible(project, currentSessionId, projects) ||
      !isSessionProjectCompatible(project, nextSessionId, projects)
    ) {
      break;
    }

    const canonicalSourceSessionId = getCanonicalCompactContinuationSource(aliases, nextSessionId);
    if (canonicalSourceSessionId && canonicalSourceSessionId !== currentSessionId) break;

    const provider = getProjectSessionProvider(project, nextSessionId);
    if (!provider) break;

    chain.push({ sessionId: nextSessionId, provider });
    seen.add(nextSessionId);
    currentSessionId = nextSessionId;
  }

  return chain;
};
