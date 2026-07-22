import type { Project, SessionProvider } from '../../../types/app';

const HIDDEN_SESSION_IDS_KEY = 'compactContinuationHiddenSessionIds';
const SESSION_ALIASES_KEY = 'compactContinuationSessionAliases';
const SESSION_PROVIDERS_KEY = 'compactContinuationSessionProviders';
const SESSION_PROJECTS_KEY = 'compactContinuationSessionProjects';

// Deployment-specific repairs belong in local runtime data and must never be
// committed to the distributable source tree.
const MANUAL_CONTINUATION_REPAIRS: Array<{
  projectName: string;
  visibleSessionId: string;
  provider: SessionProvider;
  continuationSessionIds: string[];
}> = [];

const MANUALLY_ABSORBED_CONTINUATION_IDS = new Set(
  MANUAL_CONTINUATION_REPAIRS.flatMap((repair) => repair.continuationSessionIds),
);

const MANUAL_UNHIDE_SESSION_IDS = new Set<string>();

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
  const ids = readStringArray(HIDDEN_SESSION_IDS_KEY).filter(
    (id) => !MANUAL_UNHIDE_SESSION_IDS.has(id),
  );
  return new Set(ids);
};

export const getManuallyAbsorbedContinuationSessionIds = (): Set<string> =>
  new Set(MANUALLY_ABSORBED_CONTINUATION_IDS);

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

const getContinuationSessionTime = (session: CompactContinuationSessionLike): number => {
  const value = session.lastActivity || session.updated_at || session.createdAt;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const isProviderHandoffSummary = (summary: unknown): boolean =>
  typeof summary === 'string' && summary.startsWith('The visible conversation is switching from ');

export const repairCompactContinuationChainForProject = (
  projectName: string | null | undefined,
  sessions: CompactContinuationSessionLike[],
): boolean => {
  if (!projectName || !sessions.length || !canUseLocalStorage()) return false;

  let manualRepairApplied = false;
  for (const repair of MANUAL_CONTINUATION_REPAIRS) {
    if (repair.projectName !== projectName) continue;

    const visibleExists = sessions.some((session) => session.id === repair.visibleSessionId);
    const continuationIds = repair.continuationSessionIds.filter((continuationSessionId) =>
      sessions.some((session) => session.id === continuationSessionId),
    );
    if (!visibleExists || continuationIds.length === 0) continue;

    const aliases = readAliases();
    const aliasesBefore = JSON.stringify(aliases);
    delete aliases[repair.visibleSessionId];
    for (const continuationId of continuationIds) {
      delete aliases[continuationId];
    }
    for (const [sourceId, targetId] of Object.entries({ ...aliases })) {
      if (continuationIds.includes(targetId)) {
        delete aliases[sourceId];
      }
    }
    aliases[repair.visibleSessionId] = continuationIds[continuationIds.length - 1];
    if (JSON.stringify(aliases) !== aliasesBefore) {
      writeAliases(aliases);
      manualRepairApplied = true;
    }

    const existingHiddenIds = readStringArray(HIDDEN_SESSION_IDS_KEY);
    const safeToHide = continuationIds.filter((id) => !MANUAL_UNHIDE_SESSION_IDS.has(id));
    if (safeToHide.some((continuationId) => !existingHiddenIds.includes(continuationId))) {
      writeStringArray(HIDDEN_SESSION_IDS_KEY, [
        ...existingHiddenIds,
        ...safeToHide,
      ]);
      manualRepairApplied = true;
    }

    const providers = readProviders();
    const providersBefore = JSON.stringify(providers);
    delete providers[repair.visibleSessionId];
    for (const continuationId of continuationIds) {
      providers[continuationId] = repair.provider;
    }
    if (JSON.stringify(providers) !== providersBefore) {
      writeProviders(providers);
      manualRepairApplied = true;
    }

    const projects = readProjects();
    const projectsBefore = JSON.stringify(projects);
    projects[repair.visibleSessionId] = projectName;
    for (const continuationId of continuationIds) {
      projects[continuationId] = projectName;
    }
    if (JSON.stringify(projects) !== projectsBefore) {
      writeProjects(projects);
      manualRepairApplied = true;
    }
  }

  const compactSessions = sessions
    .filter((session) =>
      session.id &&
      session.isCompactContinuation &&
      String(session.__provider || session.provider || '') === 'codex' &&
      !MANUAL_UNHIDE_SESSION_IDS.has(String(session.id)),
    )
    .sort((a, b) => getContinuationSessionTime(a) - getContinuationSessionTime(b));

  if (compactSessions.length) {
    const compactIds = new Set(compactSessions.map((session) => String(session.id)));
    const sessionById = new Map(
      sessions
        .filter((session) => session.id)
        .map((session) => [String(session.id), session] as const),
    );
    const aliases = readAliases();
    let changed = false;

    for (const [visibleSourceId, currentTargetId] of Object.entries({ ...aliases })) {
      const visibleSource = sessionById.get(visibleSourceId);
      const currentTarget = sessionById.get(currentTargetId);
      if (!visibleSource || !currentTarget || !compactIds.has(currentTargetId)) continue;

      const targetTime = getContinuationSessionTime(currentTarget);
      const extensions = compactSessions
        .filter((session) => String(session.id) !== visibleSourceId)
        .filter((session) => getContinuationSessionTime(session) > targetTime);
      if (!extensions.length) continue;

      aliases[visibleSourceId] = String(extensions[extensions.length - 1].id);
      const hiddenIds = readStringArray(HIDDEN_SESSION_IDS_KEY);
      const extensionIds = extensions.map((session) => String(session.id));
      if (extensionIds.some((id) => !hiddenIds.includes(id))) {
        writeStringArray(HIDDEN_SESSION_IDS_KEY, [...hiddenIds, ...extensionIds]);
        changed = true;
      }

      const providers = readProviders();
      const providersBefore = JSON.stringify(providers);
      providers[visibleSourceId] = 'codex';
      for (const id of extensionIds) {
        providers[id] = 'codex';
      }
      if (JSON.stringify(providers) !== providersBefore) {
        writeProviders(providers);
        changed = true;
      }

      const projects = readProjects();
      const projectsBefore = JSON.stringify(projects);
      projects[visibleSourceId] = projectName;
      for (const id of extensionIds) {
        projects[id] = projectName;
      }
      if (JSON.stringify(projects) !== projectsBefore) {
        writeProjects(projects);
        changed = true;
      }
    }

    const aliasesBefore = JSON.stringify(readAliases());
    if (JSON.stringify(aliases) !== aliasesBefore) {
      writeAliases(aliases);
      changed = true;
    }

    manualRepairApplied = manualRepairApplied || changed;
  }

  const handoffSessions = sessions
    .filter((session) =>
      session.id &&
      !MANUALLY_ABSORBED_CONTINUATION_IDS.has(String(session.id)) &&
      (session.__provider || session.provider) &&
      isProviderHandoffSummary(session.summary),
    )
    .sort((a, b) => getContinuationSessionTime(a) - getContinuationSessionTime(b));
  if (!handoffSessions.length) return manualRepairApplied;

  const handoffIds = new Set(handoffSessions.map((session) => String(session.id)));
  const aliases = readAliases();
  let visibleSources = Array.from(new Set(
    Object.entries(aliases)
      .filter(([, continuationSessionId]) => handoffIds.has(continuationSessionId))
      .map(([visibleSessionId]) => visibleSessionId)
      .filter((visibleSessionId) => !handoffIds.has(visibleSessionId)),
  ));

  if (visibleSources.length === 0) {
    const titleMatchedSources = sessions
      .filter((session) => {
        const provider = session.__provider || session.provider;
        const title = `${session.summary || ''} ${session.name || ''}`;
        return provider === 'claude' && session.id && title.includes('数据集切分');
      })
      .map((session) => String(session.id));
    if (titleMatchedSources.length === 1) {
      visibleSources = titleMatchedSources;
    }
  }

  if (visibleSources.length !== 1) return false;

  const visibleSourceId = visibleSources[0];
  let changed = false;

  const aliasesBefore = JSON.stringify(aliases);
  aliases[visibleSourceId] = String(handoffSessions[0].id);
  for (let index = 0; index < handoffSessions.length; index += 1) {
    const currentId = String(handoffSessions[index].id);
    const nextId = handoffSessions[index + 1]?.id ? String(handoffSessions[index + 1].id) : null;
    if (nextId) {
      aliases[currentId] = nextId;
    } else if (aliases[currentId]) {
      delete aliases[currentId];
    }
  }

  for (const [sourceId, targetId] of Object.entries({ ...aliases })) {
    if (
      sourceId !== visibleSourceId &&
      !handoffIds.has(sourceId) &&
      handoffIds.has(targetId)
    ) {
      delete aliases[sourceId];
    }
  }
  if (JSON.stringify(aliases) !== aliasesBefore) {
    writeAliases(aliases);
    changed = true;
  }

  const existingHiddenIds = readStringArray(HIDDEN_SESSION_IDS_KEY);
  const newHandoffIds = Array.from(handoffIds).filter((id) => !MANUAL_UNHIDE_SESSION_IDS.has(id));
  if (newHandoffIds.some((handoffId) => !existingHiddenIds.includes(handoffId))) {
    writeStringArray(HIDDEN_SESSION_IDS_KEY, [
      ...existingHiddenIds,
      ...newHandoffIds,
    ]);
    changed = true;
  }

  const provider = String(handoffSessions[handoffSessions.length - 1].__provider || handoffSessions[handoffSessions.length - 1].provider || '');
  if (provider) {
    const providers = readProviders();
    const providersBefore = JSON.stringify(providers);
    providers[visibleSourceId] = provider;
    for (const handoffId of handoffIds) {
      providers[handoffId] = provider;
    }
    if (JSON.stringify(providers) !== providersBefore) {
      writeProviders(providers);
      changed = true;
    }
  }

  const projects = readProjects();
  const projectsBefore = JSON.stringify(projects);
  projects[visibleSourceId] = projectName;
  for (const handoffId of handoffIds) {
    projects[handoffId] = projectName;
  }
  if (JSON.stringify(projects) !== projectsBefore) {
    writeProjects(projects);
    changed = true;
  }

  return changed;
};

export const rememberCompactContinuationSession = (
  visibleSessionId: string | null | undefined,
  continuationSessionId: string | null | undefined,
  provider?: string | null,
  projectName?: string | null,
) => {
  if (!visibleSessionId || !continuationSessionId || visibleSessionId === continuationSessionId) return;
  if (MANUAL_UNHIDE_SESSION_IDS.has(continuationSessionId)) return;

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
