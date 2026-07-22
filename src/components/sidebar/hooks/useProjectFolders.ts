// 加载某 project 的文件夹树 + session→folder 归属，并提供 CRUD 动作
// 注意：删 folder 仅清前端视图层元数据，不影响 ~/.claude/projects 下的 .jsonl
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../utils/api';

export interface FolderRow {
  id: number;
  project_name: string;
  parent_id: number | null;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface MembershipRow {
  session_id: string;
  provider: string;
  folder_id: number;
}

export interface FolderNode extends FolderRow {
  children: FolderNode[];
  depth: number; // 0 = 顶层
}

const sessionKey = (sessionId: string, provider: string) => `${provider}::${sessionId}`;

function buildTree(folders: FolderRow[]): FolderNode[] {
  const byId = new Map<number, FolderNode>();
  for (const f of folders) {
    byId.set(f.id, { ...f, children: [], depth: 0 });
  }
  const roots: FolderNode[] = [];
  for (const f of folders) {
    const node = byId.get(f.id)!;
    if (f.parent_id != null && byId.has(f.parent_id)) {
      const parent = byId.get(f.parent_id)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // 计算 depth
  const stack: Array<{ node: FolderNode; depth: number }> = roots.map((n) => ({ node: n, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    node.depth = depth;
    for (const c of node.children) stack.push({ node: c, depth: depth + 1 });
  }
  return roots;
}

export function useProjectFolders(projectName: string | undefined, enabled: boolean) {
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [membership, setMembership] = useState<MembershipRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const lastProjectRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectName) return;
    try {
      const res = await api.folders.list(projectName);
      if (!res.ok) return;
      const data = await res.json();
      setFolders(Array.isArray(data?.folders) ? data.folders : []);
      setMembership(Array.isArray(data?.membership) ? data.membership : []);
      setLoaded(true);
    } catch {
      /* ignore network */
    }
  }, [projectName]);

  // 项目首次展开时拉取
  useEffect(() => {
    if (!enabled || !projectName) return;
    if (lastProjectRef.current === projectName && loaded) return;
    lastProjectRef.current = projectName;
    refresh();
  }, [enabled, projectName, refresh, loaded]);

  const tree = useMemo(() => buildTree(folders), [folders]);

  // session_id+provider → folder_id（null 表示根目录）
  const sessionToFolder = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of membership) m.set(sessionKey(row.session_id, row.provider), row.folder_id);
    return m;
  }, [membership]);

  const flatFolders = useMemo(() => {
    // DFS 平铺，用于 "移动到..." 菜单
    const out: FolderNode[] = [];
    const walk = (nodes: FolderNode[]) => {
      for (const n of nodes) {
        out.push(n);
        walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const childrenByParent = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const folder of folders) {
      if (folder.parent_id == null) continue;
      const children = map.get(folder.parent_id) ?? [];
      children.push(folder.id);
      map.set(folder.parent_id, children);
    }
    return map;
  }, [folders]);

  const getFolderSessionCount = useCallback(
    (folderId: number) => {
      const folderIds = new Set<number>();
      const collect = (id: number) => {
        folderIds.add(id);
        for (const childId of childrenByParent.get(id) ?? []) {
          collect(childId);
        }
      };
      collect(folderId);

      const uniqueSessions = new Set<string>();
      for (const row of membership) {
        if (folderIds.has(row.folder_id)) {
          uniqueSessions.add(sessionKey(row.session_id, row.provider));
        }
      }
      return uniqueSessions.size;
    },
    [childrenByParent, membership],
  );

  const createFolder = useCallback(
    async (parentId: number | null, name: string) => {
      if (!projectName) return null;
      try {
        const res = await api.folders.create(projectName, { name, parent_id: parentId });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || '创建失败');
        }
        await refresh();
        return true;
      } catch (e) {
        console.warn('createFolder failed', e);
        throw e;
      }
    },
    [projectName, refresh],
  );

  const renameFolder = useCallback(
    async (folderId: number, name: string) => {
      if (!projectName) return;
      const res = await api.folders.update(projectName, folderId, { name });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || '重命名失败');
      }
      await refresh();
    },
    [projectName, refresh],
  );

  const moveFolder = useCallback(
    async (folderId: number, parentId: number | null) => {
      if (!projectName) return;
      const res = await api.folders.update(projectName, folderId, { parent_id: parentId });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || '移动失败');
      }
      await refresh();
    },
    [projectName, refresh],
  );

  const removeFolder = useCallback(
    async (folderId: number) => {
      if (!projectName) return;
      const res = await api.folders.remove(projectName, folderId);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || '删除失败');
      }
      await refresh();
    },
    [projectName, refresh],
  );

  const fetchContentsCount = useCallback(
    async (folderId: number) => {
      if (!projectName) return { sessions: 0, folders: 0 };
      try {
        const res = await api.folders.contentsCount(projectName, folderId);
        if (!res.ok) return { sessions: 0, folders: 0 };
        const data = await res.json();
        return { sessions: Number(data?.sessions || 0), folders: Number(data?.folders || 0) };
      } catch {
        return { sessions: 0, folders: 0 };
      }
    },
    [projectName],
  );

  const moveSession = useCallback(
    async (sessionId: string, provider: string, folderId: number | null) => {
      if (!projectName) return;
      // 乐观更新本地 membership，避免拖拽后 UI 闪烁
      setMembership((prev) => {
        const filtered = prev.filter((m) => !(m.session_id === sessionId && m.provider === provider));
        if (folderId == null) return filtered;
        return [...filtered, { session_id: sessionId, provider, folder_id: folderId }];
      });
      try {
        const res = await api.folders.moveSession(sessionId, {
          projectName,
          provider,
          folderId,
        });
        if (!res.ok) {
          await refresh();
          throw new Error('移动失败');
        }
      } catch (e) {
        await refresh();
        throw e;
      }
    },
    [projectName, refresh],
  );

  const folderOfSession = useCallback(
    (sessionId: string, provider: string): number | null => {
      return sessionToFolder.get(sessionKey(sessionId, provider)) ?? null;
    },
    [sessionToFolder],
  );

  return {
    folders,
    tree,
    flatFolders,
    loaded,
    folderOfSession,
    getFolderSessionCount,
    refresh,
    createFolder,
    renameFolder,
    moveFolder,
    removeFolder,
    fetchContentsCount,
    moveSession,
  };
}
