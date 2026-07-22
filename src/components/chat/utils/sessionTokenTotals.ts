import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';

// 模块级别：追踪正在恢复中的 sessionId，避免并发重复请求
const recoveringSet = new Set<string>();

const KEY = (sessionId: string) => `session-tokens-v1-${sessionId}`;
// 标记已做过历史恢复，避免重复请求
// v2 invalidates the old one-file Codex recovery marker. That implementation
// permanently preserved partial values such as the latest invocation's output.
const RECOVERED_KEY = (sessionId: string, provider = 'claude') => `session-tokens-recovered-v2-${provider}-${sessionId}`;
const EVENT = 'session-tokens-updated';
// 实时「在途」用量事件：本轮进行中、尚未落库的 token，用于让 ↑/↓ 即时跳动
const LIVE_EVENT = 'session-tokens-live';

// 在途用量只放内存（不写 localStorage），每轮结束落库后清零，避免与持久值重复计数
const liveTotals = new Map<string, SessionTokenTotals>();

function getLiveSessionTokens(sessionId: string): SessionTokenTotals {
  return liveTotals.get(sessionId) || { input: 0, output: 0 };
}

// 流式过程中持续调用：覆盖式写入当前轮的真实 token 用量（非累加，与落库逻辑一致）
export function setLiveSessionTokens(sessionId: string, input: number, output: number) {
  if (!sessionId) return;
  liveTotals.set(sessionId, { input: Math.max(0, input || 0), output: Math.max(0, output || 0) });
  window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: { sessionId } }));
}

// 每轮结束、用量已落库后调用：清零在途值，避免与持久值叠加
export function clearLiveSessionTokens(sessionId: string) {
  if (!sessionId || !liveTotals.has(sessionId)) return;
  liveTotals.delete(sessionId);
  window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: { sessionId } }));
}

export interface SessionTokenTotals {
  input: number;
  output: number;
}

export function getSessionTokenTotals(sessionId: string): SessionTokenTotals {
  try {
    const raw = localStorage.getItem(KEY(sessionId));
    if (!raw) return { input: 0, output: 0 };
    const parsed = JSON.parse(raw);
    return { input: Number(parsed.input) || 0, output: Number(parsed.output) || 0 };
  } catch { return { input: 0, output: 0 }; }
}

export function setSessionTokenTotals(sessionId: string, input: number, output: number) {
  try {
    localStorage.setItem(KEY(sessionId), JSON.stringify({ input, output }));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { sessionId } }));
  } catch { /* ignore */ }
}

export function addSessionTokens(sessionId: string, input: number, output: number) {
  if (!sessionId || (input <= 0 && output <= 0)) return;
  try {
    const prev = getSessionTokenTotals(sessionId);
    localStorage.setItem(KEY(sessionId), JSON.stringify({
      input: prev.input + input,
      output: prev.output + output,
    }));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { sessionId } }));
  } catch { /* ignore */ }
}

// 从服务端 jsonl 追回历史 token 用量（仅在 localStorage 无记录时执行一次）
async function recoverHistoricalTokens(sessionId: string, projectName: string, provider: string): Promise<void> {
  if (localStorage.getItem(RECOVERED_KEY(sessionId, provider))) return;
  const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}/cumulative-tokens?provider=${encodeURIComponent(provider)}`;
  try {
    const res = await authenticatedFetch(url);
    if (!res.ok) return;
    const data = await res.json() as { input: number; output: number };
    if ((data.input || 0) > 0 || (data.output || 0) > 0) {
      setSessionTokenTotals(sessionId, data.input || 0, data.output || 0);
    }
    localStorage.setItem(RECOVERED_KEY(sessionId, provider), '1');
  } catch { /* ignore，下次再试 */ }
}

export function useSessionTokenTotals(
  sessionId: string | null,
  projectName?: string | null,
  provider = 'claude',
): SessionTokenTotals {
  // 持久值（已落库）与在途值（本轮进行中）分开存，渲染时相加 → ↑/↓ 实时跳动
  const [persisted, setPersisted] = useState<SessionTokenTotals>(() =>
    sessionId ? getSessionTokenTotals(sessionId) : { input: 0, output: 0 },
  );
  const [live, setLive] = useState<SessionTokenTotals>(() =>
    sessionId ? getLiveSessionTokens(sessionId) : { input: 0, output: 0 },
  );

  useEffect(() => {
    if (!sessionId) { setPersisted({ input: 0, output: 0 }); setLive({ input: 0, output: 0 }); return; }
    setPersisted(getSessionTokenTotals(sessionId));
    setLive(getLiveSessionTokens(sessionId));

    // 如果 localStorage 没有数据且有 projectName，自动追回历史
    if (projectName && !localStorage.getItem(RECOVERED_KEY(sessionId, provider)) && !recoveringSet.has(`${provider}:${sessionId}`)) {
      const recoveryId = `${provider}:${sessionId}`;
      recoveringSet.add(recoveryId);
      recoverHistoricalTokens(sessionId, projectName, provider).finally(() => recoveringSet.delete(recoveryId));
    }

    const persistedHandler = (e: Event) => {
      if ((e as CustomEvent).detail?.sessionId === sessionId) {
        setPersisted(getSessionTokenTotals(sessionId));
      }
    };
    const liveHandler = (e: Event) => {
      if ((e as CustomEvent).detail?.sessionId === sessionId) {
        setLive(getLiveSessionTokens(sessionId));
      }
    };
    window.addEventListener(EVENT, persistedHandler);
    window.addEventListener(LIVE_EVENT, liveHandler);
    return () => {
      window.removeEventListener(EVENT, persistedHandler);
      window.removeEventListener(LIVE_EVENT, liveHandler);
    };
  }, [sessionId, projectName, provider]);

  return {
    input: persisted.input + live.input,
    output: persisted.output + live.output,
  };
}
