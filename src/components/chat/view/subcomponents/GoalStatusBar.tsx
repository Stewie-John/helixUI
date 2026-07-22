import { Check, History as HistoryIcon, Pause, Play, Target, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';

type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

type Goal = {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt?: number;
  updatedAt?: number;
  isCurrent?: boolean;
};

function formatDuration(seconds: number) {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function goalStatusColor(status: GoalStatus) {
  return status === 'active'
    ? '#42f5a7'
    : status === 'complete'
      ? '#63d9ff'
      : status === 'paused'
        ? '#ffd45c'
        : '#ff8f70';
}

function GoalHistoryModal({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void authenticatedFetch(`/api/codex/goals/${encodeURIComponent(sessionId)}/history`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Goal history failed (${response.status})`);
        const data = await response.json();
        if (!cancelled) setHistory(Array.isArray(data?.history) ? data.history : []);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  const formatDateTime = (value?: number) => value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : t('goal.unknownTime');

  return createPortal(
    <div
      role="presentation"
      onMouseDown={onClose}
      className="fixed inset-0 z-[10000] grid place-items-center overflow-y-auto bg-slate-950/90 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('goal.history')}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[min(760px,calc(100vw-24px))] overflow-hidden rounded border border-cyan-400/60 bg-[#061019] text-cyan-50 shadow-[0_0_36px_rgba(0,210,255,0.18)]"
      >
        <header className="flex items-center justify-between border-b border-cyan-400/20 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <HistoryIcon size={17} className="shrink-0 text-cyan-300" />
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.12em] text-cyan-200">{t('goal.history')}</div>
              <div className="mt-0.5 text-[10px] text-cyan-100/45">{t('goal.historyDescription')}</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-cyan-200 hover:bg-cyan-300/10" title={t('buttons.close')}>
            <X size={18} />
          </button>
        </header>

        <div className="max-h-[min(680px,calc(100vh-120px))] overflow-y-auto p-3 sm:p-4">
          {loading && <div className="py-12 text-center text-xs text-cyan-200/70">{t('status.loading')}</div>}
          {error && <div className="border border-red-400/30 bg-red-950/30 p-3 text-xs text-red-200">{error}</div>}
          {!loading && !error && history.length === 0 && (
            <div className="py-12 text-center text-xs text-cyan-100/45">{t('goal.noHistory')}</div>
          )}
          {!loading && !error && history.map((item, index) => {
            const color = goalStatusColor(item.status);
            const progress = item.tokenBudget
              ? Math.min(100, Math.max(0, item.tokensUsed / item.tokenBudget * 100))
              : null;
            return (
              <article key={item.goalId} className="mb-2 border border-cyan-400/20 bg-cyan-950/20 p-3 last:mb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color }}>
                    {t(`goal.status.${item.status}`)}
                  </span>
                  {item.isCurrent && <span className="border border-emerald-400/35 px-1.5 py-0.5 text-[9px] uppercase text-emerald-300">{t('goal.current')}</span>}
                  <span className="ml-auto text-[10px] tabular-nums text-cyan-100/40">#{history.length - index}</span>
                </div>
                <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-cyan-50/90">{item.objective}</div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-cyan-400/10 pt-2 text-[10px] tabular-nums text-cyan-100/55">
                  <span title="Codex Goal 官方累计：非缓存输入 + 输出 tokens">{item.tokensUsed.toLocaleString()}{item.tokenBudget ? ` / ${item.tokenBudget.toLocaleString()}` : ''} tok</span>
                  {progress !== null && <span>{progress.toFixed(1)}%</span>}
                  <span>{formatDuration(item.timeUsedSeconds)}</span>
                  <span>{formatDateTime(item.createdAt)} → {formatDateTime(item.updatedAt)}</span>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function GoalStatusBar({
  sessionId,
  provider,
  isLoading,
}: {
  sessionId?: string | null;
  provider: string;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const enabled = provider === 'codex'
    && Boolean(sessionId)
    && !String(sessionId).startsWith('new-session-');

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) {
      setGoal(null);
      setHistoryCount(0);
      return;
    }
    try {
      const response = await authenticatedFetch(`/api/codex/goals/${encodeURIComponent(sessionId)}`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      const data = await response.json();
      setGoal(data?.goal || null);
      setHistoryCount(Number(data?.historyCount || 0));
      window.dispatchEvent(new CustomEvent('helix:goal-usage', {
        detail: {
          sessionId,
          tokensUsed: Number(data?.goal?.tokensUsed || 0),
          status: data?.goal?.status || null,
        },
      }));
    } catch { /* polling is best effort */ }
  }, [enabled, sessionId]);

  useEffect(() => {
    void refresh();
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, isLoading ? 2500 : 5000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, isLoading, refresh]);

  const setStatus = async (status: 'active' | 'paused' | 'complete') => {
    if (!sessionId || busyAction) return;
    setBusyAction(status);
    try {
      const response = await authenticatedFetch(`/api/codex/goals/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (response.ok) await refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const closeGoalPanel = async () => {
    if (!sessionId || busyAction) return;
    if (!window.confirm(t('goal.closePanelConfirm'))) return;
    setBusyAction('clear');
    try {
      const response = await authenticatedFetch(`/api/codex/goals/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        setGoal(null);
        setHistoryCount((count) => Math.max(1, count));
      }
    } finally {
      setBusyAction(null);
    }
  };

  if (!enabled || (!goal && historyCount === 0)) return null;

  if (!goal && sessionId) {
    return (
      <>
        <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="flex h-8 min-w-0 items-center gap-2 border border-cyan-400/30 bg-cyan-950/30 px-3 text-left hover:bg-cyan-900/35"
        >
          <HistoryIcon size={15} className="shrink-0 text-cyan-300" />
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-cyan-200">{t('goal.history')}</span>
          <span className="text-[10px] tabular-nums text-cyan-100/45">{historyCount}</span>
          <span className="text-[10px] text-cyan-100/40">{t('goal.openHistory')}</span>
        </button>
        </div>
        <GoalHistoryModal sessionId={sessionId} open={historyOpen} onClose={() => setHistoryOpen(false)} />
      </>
    );
  }

  if (!goal || !sessionId) return null;

  const statusColor = goalStatusColor(goal.status);
  const progress = goal.tokenBudget
    ? Math.min(100, Math.max(0, goal.tokensUsed / goal.tokenBudget * 100))
    : null;

  return (
    <>
    <div
      role="status"
      className="mb-2 flex h-10 min-w-0 items-center gap-2 border-y border-cyan-400/30 bg-cyan-950/35 px-2 sm:px-3"
      style={{ boxShadow: 'inset 0 0 16px rgba(0,170,220,0.08)' }}
    >
      <Target size={16} color={statusColor} className="shrink-0" />
      <span
        className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em]"
        style={{ color: statusColor }}
      >
        {t(`goal.status.${goal.status}`)}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-cyan-50/90" title={goal.objective}>
        {goal.objective}
      </span>
      <span className="hidden shrink-0 items-center gap-2 text-[10px] tabular-nums text-cyan-100/55 sm:flex">
        {progress !== null && <span>{progress.toFixed(1)}%</span>}
        <span title="Codex Goal 官方累计：非缓存输入 + 输出 tokens">{goal.tokensUsed.toLocaleString()}{goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''} tok</span>
        <span>{formatDuration(goal.timeUsedSeconds)}</span>
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={() => setHistoryOpen(true)} className="flex h-7 items-center gap-1.5 border border-cyan-400/25 px-2 text-cyan-200 hover:bg-cyan-300/10" title={t('goal.history')}>
          <HistoryIcon size={14} />
          <span className="hidden text-[9px] font-bold uppercase tracking-[0.08em] sm:inline">{t('goal.history')}</span>
          <span className="text-[9px] tabular-nums">{historyCount}</span>
        </button>
        {goal.status === 'active' ? (
          <button type="button" onClick={() => void setStatus('paused')} disabled={Boolean(busyAction)} className="p-1 text-amber-300 hover:bg-cyan-300/10 disabled:opacity-40" title={t('goal.pause')}>
            <Pause size={14} />
          </button>
        ) : goal.status !== 'complete' ? (
          <button type="button" onClick={() => void setStatus('active')} disabled={Boolean(busyAction)} className="p-1 text-emerald-300 hover:bg-cyan-300/10 disabled:opacity-40" title={t('goal.resume')}>
            <Play size={14} />
          </button>
        ) : null}
        {goal.status !== 'complete' && (
          <button type="button" onClick={() => void setStatus('complete')} disabled={Boolean(busyAction)} className="p-1 text-cyan-300 hover:bg-cyan-300/10 disabled:opacity-40" title={t('goal.complete')}>
            <Check size={15} />
          </button>
        )}
        {goal.status === 'complete' && (
          <button type="button" onClick={() => void closeGoalPanel()} disabled={Boolean(busyAction)} className="p-1 text-cyan-100/55 hover:bg-cyan-300/10 hover:text-cyan-100 disabled:opacity-40" title={t('goal.closePanel')}>
            <X size={14} />
          </button>
        )}
      </div>
    </div>
    <GoalHistoryModal sessionId={sessionId} open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}
