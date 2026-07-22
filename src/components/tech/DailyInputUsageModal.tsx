import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../utils/api';

type CurrentAccount = {
  userId: number;
  username: string;
  isAdmin: boolean;
};

type UserTotal = {
  userId: number;
  username: string;
  todayCount: number;
  totalCount: number;
  todayInputTokens: number;
  todayCachedInputTokens: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  todayOutputTokens: number;
  totalOutputTokens: number;
  todayEstimatedCredits: number;
  totalEstimatedCredits: number;
  hasUnknownPricing: boolean;
};

type UsageHistory = {
  userId: number;
  username: string;
  timeZone: string;
  startDay: string;
  endDay: string;
  days: Array<{ day: string; charCount: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; estimatedCredits: number; hasUnknownPricing: boolean }>;
  summary: {
    lifetimeCount: number;
    peakCount: number;
    activeDays: number;
    currentStreak: number;
    bestStreak: number;
    lifetimeInputTokens: number;
    peakInputTokens: number;
    modelInputDays: number;
    lifetimeOutputTokens: number;
    peakOutputTokens: number;
    outputDays: number;
  };
};

type CalendarCell = { day: string; charCount: number; inputTokens: number; outputTokens: number; inRange: boolean };

const DAY_MS = 86_400_000;
const HEAT_RANGES = {
  characters: ['#20272b', '#ffe29a', '#fff9df'],
  modelInput: ['#20272b', '#76e6ff', '#d9faff'],
  output: ['#20272b', '#ff8ed0', '#ffe0f2'],
} as const;

const parseDay = (day: string) => new Date(`${day}T00:00:00Z`);
const formatDay = (date: Date) => date.toISOString().slice(0, 10);

function buildCalendar(history: UsageHistory | null): CalendarCell[][] {
  if (!history) return [];
  const counts = new Map(history.days.map((entry) => [entry.day, entry]));
  const first = parseDay(history.startDay);
  const last = parseDay(history.endDay);
  const calendarStart = new Date(first.getTime() - first.getUTCDay() * DAY_MS);
  const calendarEnd = new Date(last.getTime() + (6 - last.getUTCDay()) * DAY_MS);
  const weeks: CalendarCell[][] = [];

  for (let cursor = calendarStart.getTime(); cursor <= calendarEnd.getTime(); cursor += 7 * DAY_MS) {
    const week: CalendarCell[] = [];
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const day = formatDay(new Date(cursor + dayOffset * DAY_MS));
      week.push({
        day,
        charCount: counts.get(day)?.charCount || 0,
        inputTokens: counts.get(day)?.inputTokens || 0,
        outputTokens: counts.get(day)?.outputTokens || 0,
        inRange: day >= history.startDay && day <= history.endDay,
      });
    }
    weeks.push(week);
  }
  return weeks;
}

function interpolateHex(from: string, to: string, amount: number) {
  const clamped = Math.max(0, Math.min(1, amount));
  const read = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  const channel = (offset: number) => Math.round(read(from, offset) + (read(to, offset) - read(from, offset)) * clamped);
  return `#${[1, 3, 5].map((offset) => channel(offset).toString(16).padStart(2, '0')).join('')}`;
}

function interpolateHeatColor(range: readonly [string, string, string], amount: number) {
  const accentStop = 0.78;
  if (amount <= accentStop) {
    return interpolateHex(range[0], range[1], amount / accentStop);
  }
  return interpolateHex(range[1], range[2], (amount - accentStop) / (1 - accentStop));
}

function continuousHeatAmount(value: number, peak: number, positiveValues: number[]) {
  if (value <= 0 || peak <= 0 || positiveValues.length === 0) return 0;
  const valueRatio = Math.min(1, value / peak);
  let lowerCount = 0;
  let equalCount = 0;
  for (const candidate of positiveValues) {
    if (candidate < value) lowerCount += 1;
    else if (candidate === value) equalCount += 1;
  }
  const rank = positiveValues.length <= 1
    ? 1
    : (lowerCount + Math.max(0, equalCount - 1) / 2) / (positiveValues.length - 1);
  // Magnitude drives most of the color span so, for example, 200k and 800k
  // cannot both collapse into the bright end. Rank retains visible separation
  // between nearby low-volume days without flattening genuine large gaps.
  const magnitude = Math.pow(valueRatio, 0.68);
  return Math.min(1, 0.12 + 0.88 * (0.3 * rank + 0.7 * magnitude));
}

function ActivityGrid({
  weeks,
  monthLabels,
  peak,
  metric,
  selectedDay,
  canSelect,
  onSelect,
}: {
  weeks: CalendarCell[][];
  monthLabels: string[];
  peak: number;
  metric: 'characters' | 'modelInput' | 'output';
  selectedDay: Pick<CalendarCell, 'day'> | null;
  canSelect: boolean;
  onSelect: (cell: CalendarCell) => void;
}) {
  const { t } = useTranslation();
  const output = metric === 'output';
  const modelInput = metric === 'modelInput';
  const range = HEAT_RANGES[metric];
  const accent = output ? '#ff8ed0' : modelInput ? '#76e6ff' : '#ffe29a';
  const positiveValues = useMemo(() => weeks
    .flatMap((week) => week)
    .filter((cell) => cell.inRange)
    .map((cell) => output ? cell.outputTokens : modelInput ? cell.inputTokens : cell.charCount)
    .filter((value) => value > 0)
    .sort((left, right) => left - right), [modelInput, output, weeks]);
  return (
    <div style={{ marginTop: 15 }}>
      <div style={{ color: accent, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', marginBottom: 7 }}>
        {t(output ? 'hud.outputActivity' : modelInput ? 'hud.modelInputActivity' : 'hud.inputActivity')}
      </div>
      <div style={{ overflowX: 'auto', paddingBottom: 7 }}>
        <div style={{ minWidth: 790, width: 'max-content' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '28px auto', gap: 8, marginBottom: 6 }}>
            <span />
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${weeks.length}, 12px)`, gap: 3, height: 17, color: '#aeb7bb', fontSize: 11 }}>
              {monthLabels.map((label, index) => <span key={`${metric}-${label}-${index}`} style={{ whiteSpace: 'nowrap' }}>{label}</span>)}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '28px auto', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateRows: 'repeat(7, 12px)', gap: 3, color: '#aeb7bb', fontSize: 10, lineHeight: '12px' }}>
              {['', t('hud.weekdays.mon'), '', t('hud.weekdays.wed'), '', t('hud.weekdays.fri'), ''].map((label, index) => <span key={index}>{label}</span>)}
            </div>
            <div style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(7, 12px)', gridAutoColumns: '12px', gap: 3 }}>
              {weeks.flatMap((week) => week).map((cell) => {
                const value = output ? cell.outputTokens : modelInput ? cell.inputTokens : cell.charCount;
                const heatAmount = continuousHeatAmount(value, peak, positiveValues);
                const heatColor = cell.inRange
                  ? interpolateHeatColor(range, heatAmount)
                  : 'transparent';
                const selected = selectedDay?.day === cell.day;
                const unit = t(output ? 'hud.outputTokens' : modelInput ? 'hud.inputTokens' : 'hud.characters');
                return (
                  <button
                    key={`${metric}-${cell.day}`}
                    type="button"
                    className={output ? 'daily-output-heat-cell' : modelInput ? 'daily-model-input-heat-cell' : 'daily-input-heat-cell'}
                    data-heat-value={cell.inRange ? heatAmount.toFixed(4) : 'outside'}
                    disabled={!canSelect || !cell.inRange}
                    onClick={() => onSelect(cell)}
                    aria-label={`${cell.day}: ${value.toLocaleString()} ${unit}`}
                    aria-pressed={selected}
                    title={`${cell.day}: ${value.toLocaleString()} ${unit}`}
                    style={{
                      '--daily-heat-color': heatColor,
                      width: 12, height: 12, padding: 0, borderRadius: 1, border: 0,
                      outline: selected ? `1px solid ${accent}` : 'none',
                      outlineOffset: 1,
                      boxShadow: value > 0 ? `0 0 5px ${heatColor}55` : 'none',
                      cursor: canSelect && cell.inRange ? 'pointer' : 'default',
                    } as CSSProperties}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 5, color: '#929da0', fontSize: 10 }}>
        <span>{t('hud.less')}</span>
        <span style={{
          width: 74, height: 11, borderRadius: 1,
          background: `linear-gradient(90deg, ${range[0]} 0%, ${range[1]} 78%, ${range[2]} 100%)`,
          border: '1px solid rgba(255,255,255,0.08)',
        }} />
        <span>{t('hud.more')}</span>
      </div>
    </div>
  );
}

export default function DailyInputUsageModal({
  open,
  account,
  onClose,
}: {
  open: boolean;
  account: CurrentAccount;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserTotal[]>([]);
  const [selectedUserId, setSelectedUserId] = useState(account.userId);
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<Pick<CalendarCell, 'day' | 'charCount' | 'inputTokens' | 'outputTokens'> | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedUserId(account.userId);
    setSelectedDay(null);
  }, [account.userId, open]);

  useEffect(() => {
    if (!open) return;
    if (!account.isAdmin) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    const loadUsers = async (showLoading: boolean) => {
      if (showLoading) setUsersLoading(true);
      try {
        const dayQuery = selectedDay?.day ? `?day=${encodeURIComponent(selectedDay.day)}` : '';
        const response = await authenticatedFetch(`/api/user/daily-input/all${dayQuery}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Account totals failed (${response.status})`);
        const payload = await response.json() as { day?: string; users?: UserTotal[] };
        let nextUsers = Array.isArray(payload.users) ? payload.users : [];
        // During a graceful backend update, an older process can still ignore
        // the day query. Derive the selected-day ranking from the existing
        // per-user history endpoint so the UI works before that process exits.
        if (selectedDay?.day && payload.day !== selectedDay.day) {
          nextUsers = await Promise.all(nextUsers.map(async (user) => {
            const historyResponse = await authenticatedFetch(
              `/api/user/daily-input/history?userId=${user.userId}`,
              { cache: 'no-store' },
            );
            if (!historyResponse.ok) throw new Error(`Usage history failed (${historyResponse.status})`);
            const userHistory = await historyResponse.json() as UsageHistory;
            const dayUsage = userHistory.days.find((entry) => entry.day === selectedDay.day);
            return {
              ...user,
              todayCount: dayUsage?.charCount || 0,
              todayInputTokens: dayUsage?.inputTokens || 0,
              todayCachedInputTokens: dayUsage?.cachedInputTokens || 0,
              todayOutputTokens: dayUsage?.outputTokens || 0,
              todayEstimatedCredits: dayUsage?.estimatedCredits || 0,
              hasUnknownPricing: dayUsage?.hasUnknownPricing || false,
            };
          }));
        }
        if (!cancelled) {
          setUsers(nextUsers);
          setUsersError(null);
        }
      } catch (loadError) {
        if (!cancelled) setUsersError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled && showLoading) setUsersLoading(false);
      }
    };
    void loadUsers(true);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadUsers(false);
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [account.isAdmin, open, selectedDay?.day]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHistory(null);
    const loadHistory = async (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      try {
        const response = await authenticatedFetch(`/api/user/daily-input/history?userId=${selectedUserId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Usage history failed (${response.status})`);
        const payload = await response.json() as UsageHistory;
        if (!cancelled) {
          setHistory(payload);
          setSelectedDay((previous) => {
            if (!previous) return null;
            const entry = payload.days.find((day) => day.day === previous.day);
            return entry
              ? { day: entry.day, charCount: entry.charCount, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens }
              : previous;
          });
          setHistoryError(null);
        }
      } catch (loadError) {
        if (!cancelled) setHistoryError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled && showLoading) setLoading(false);
      }
    };
    void loadHistory(true);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadHistory(false);
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open, selectedUserId]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const weeks = useMemo(() => buildCalendar(history), [history]);
  const calendarPeak = useMemo(
    () => history?.days.reduce((peak, entry) => Math.max(peak, entry.charCount), 0) || 0,
    [history],
  );
  const outputCalendarPeak = useMemo(
    () => history?.days.reduce((peak, entry) => Math.max(peak, entry.outputTokens), 0) || 0,
    [history],
  );
  const inputTokenCalendarPeak = useMemo(
    () => history?.days.reduce((peak, entry) => Math.max(peak, entry.inputTokens), 0) || 0,
    [history],
  );
  const usersByDailyCost = useMemo(
    () => [...users].sort((left, right) => {
      const costDifference = (right.todayEstimatedCredits || 0) - (left.todayEstimatedCredits || 0);
      if (costDifference !== 0) return costDifference;
      const tokenDifference = (right.todayInputTokens + right.todayOutputTokens) - (left.todayInputTokens + left.todayOutputTokens);
      if (tokenDifference !== 0) return tokenDifference;
      return left.username.localeCompare(right.username, undefined, { sensitivity: 'base' });
    }),
    [users],
  );
  const monthLabels = useMemo(() => {
    let previousMonth = '';
    return weeks.map((week) => {
      const firstVisible = week.find((cell) => cell.inRange);
      if (!firstVisible) return '';
      const month = firstVisible.day.slice(0, 7);
      if (month === previousMonth) return '';
      previousMonth = month;
      return new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(parseDay(firstVisible.day));
    });
  }, [weeks]);

  if (!open) return null;
  const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const credits = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 3 : 2 }).format(value);
  const accountGridColumns = 'minmax(92px, 1.05fr) minmax(72px, .78fr) minmax(108px, 1.08fr) minmax(88px, .88fr) minmax(112px, 1.06fr) minmax(82px, .82fr) minmax(112px, 1.08fr) minmax(94px, .96fr)';
  const summary = history?.summary;
  const rankingDayLabel = selectedDay
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(parseDay(selectedDay.day))
    : t('hud.today');

  return createPortal(
    <div
      role="presentation"
      onMouseDown={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'auto',
        display: 'grid', placeItems: 'center', padding: 18,
        overflow: 'hidden',
        // A full-screen backdrop filter continuously recomposites the animated
        // page underneath on Safari. The opaque scrim keeps the same focus
        // treatment without making the modal expensive to scroll or resize.
        background: 'rgba(0, 7, 16, 0.88)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('hud.dailyInputDetails')}
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: 'min(1420px, calc(100vw - 28px))',
          overflow: 'hidden', border: '1px solid rgba(76,226,255,0.72)', borderRadius: 4,
          background: 'rgba(6,15,23,0.985)', boxShadow: '0 0 34px rgba(0,217,255,0.2)',
          color: '#edf5f2', fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
          contain: 'layout paint', transform: 'translateZ(0)',
        }}
      >
        <header style={{ padding: '16px 18px 13px', borderBottom: '1px solid rgba(76,226,255,0.2)', display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ color: '#6dffba', fontWeight: 850, fontSize: 14, letterSpacing: '0.08em' }}>
              {t('hud.dailyInput')}
            </div>
            <div style={{ color: 'rgba(202,220,222,0.65)', fontSize: 10, marginTop: 5 }}>
              {t('hud.dailyInputDetails')}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('buttons.close')} style={{ border: 0, background: 'transparent', color: '#9deeff', cursor: 'pointer', padding: 4 }}>
            <X size={19} />
          </button>
        </header>

        <div style={{ padding: '16px 18px 20px' }}>
          {account.isAdmin && (
            <section aria-labelledby="daily-input-accounts-title">
              <div
                id="daily-input-accounts-title"
                style={{ color: '#9deeff', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', marginBottom: 9 }}
              >
                {t('hud.accountInputTotals')} · {rankingDayLabel}
              </div>
              <div style={{ overflowX: 'hidden', borderTop: '1px solid rgba(76,226,255,0.2)', borderBottom: '1px solid rgba(76,226,255,0.2)' }}>
                <div style={{ width: '100%', minWidth: 0 }}>
                <div style={{ display: 'grid', gridTemplateColumns: accountGridColumns, gap: 5, padding: '7px 8px', color: 'rgba(170,226,220,0.62)', fontSize: 9, letterSpacing: '0.02em', textAlign: 'center' }}>
                  <span>{t('hud.account')}</span>
                  <span>{t(selectedDay ? 'hud.characters' : 'hud.todayCharacters')}</span>
                  <span>{t(selectedDay ? 'hud.inputTokens' : 'hud.todayModelInput')}</span>
                  <span>{t(selectedDay ? 'hud.outputTokens' : 'hud.todayOutput')}</span>
                  <span>{t('hud.codexCredits')}</span>
                  <span>{t('hud.totalCharactersLabel')}</span>
                  <span>{t('hud.totalModelInput')}</span>
                  <span>{t('hud.totalOutput')}</span>
                </div>
                {usersLoading && <div style={{ padding: '16px 10px', color: '#9deeff', fontSize: 11 }}>{t('status.loading')}</div>}
                {usersError && <div style={{ padding: '12px 10px', color: '#ff8585', fontSize: 11 }}>{usersError}</div>}
                {!usersLoading && !usersError && usersByDailyCost.map((user) => {
                  const selected = user.userId === selectedUserId;
                  return (
                    <button
                      key={user.userId}
                      type="button"
                      onClick={() => setSelectedUserId(user.userId)}
                      aria-pressed={selected}
                      style={{
                        width: '100%', display: 'grid', gridTemplateColumns: accountGridColumns,
                        gap: 5, alignItems: 'center', padding: '9px 8px', border: 0, borderTop: '1px solid rgba(76,226,255,0.1)',
                        background: selected ? 'rgba(34,205,229,0.13)' : 'transparent', color: '#edf5f2', cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: 12, textAlign: 'center',
                      }}
                    >
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: selected ? '#6dffba' : '#edf5f2', fontWeight: selected ? 800 : 600 }}>
                        {user.username}
                      </span>
                      <span style={{ color: '#f4fff9', fontVariantNumeric: 'tabular-nums' }}>{user.todayCount.toLocaleString()}</span>
                      <span style={{ color: '#76e6ff', fontVariantNumeric: 'tabular-nums' }}>↑{(user.todayInputTokens || 0).toLocaleString()}</span>
                      <span style={{ color: '#d6a7ff', fontVariantNumeric: 'tabular-nums' }}>↓{(user.todayOutputTokens || 0).toLocaleString()}</span>
                      <span title={user.hasUnknownPricing ? t('hud.partialPricing') : t('hud.officialRateCard')} style={{ color: '#6dffba', fontVariantNumeric: 'tabular-nums', fontWeight: 750 }}>
                        {user.hasUnknownPricing ? '≥' : ''}{credits(user.todayEstimatedCredits || 0)} cr
                      </span>
                      <span style={{ color: '#ffe29a', fontVariantNumeric: 'tabular-nums' }}>{user.totalCount.toLocaleString()}</span>
                      <span style={{ color: '#45c8e7', fontVariantNumeric: 'tabular-nums' }}>↑{(user.totalInputTokens || 0).toLocaleString()}</span>
                      <span style={{ color: '#c47eff', fontVariantNumeric: 'tabular-nums' }}>↓{(user.totalOutputTokens || 0).toLocaleString()}</span>
                    </button>
                  );
                })}
                </div>
              </div>
            </section>
          )}

          <section aria-labelledby="daily-input-history-title" style={{ marginTop: account.isAdmin ? 22 : 0 }}>
            <div
              id="daily-input-history-title"
              style={{ color: '#9deeff', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', marginBottom: 11 }}
            >
              {t('hud.inputHistory')} · {t('hud.last12Months')}
            </div>

          {loading && <div style={{ padding: '44px 0', textAlign: 'center', color: '#9deeff' }}>{t('status.loading')}</div>}
          {historyError && <div style={{ padding: '18px 0', color: '#ff8585' }}>{historyError}</div>}
          {!loading && !historyError && history && (
            <>
              <div style={{ fontSize: 14, color: '#dce7e4', fontWeight: 750 }}>{history.username}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginTop: 7, color: '#a9b1b2', fontSize: 12, lineHeight: 1.65 }}>
                <span>{t('hud.totalCharacters')} <b style={{ color: '#ffe29a' }}>{compact(summary?.lifetimeCount || 0)}</b></span>
                <span>· {t('hud.dailyPeak')} <b style={{ color: '#ffd0a3' }}>{compact(summary?.peakCount || 0)}</b></span>
                <span>· {t('hud.inputStreak')} <b style={{ color: '#ffe29a' }}>{summary?.currentStreak || 0}d</b> ({t('hud.longestStreak')} {summary?.bestStreak || 0}d)</span>
                <span>· {t('hud.inputDays')} <b style={{ color: '#b8e8da' }}>{summary?.activeDays || 0}</b></span>
                <span>· {t('hud.totalModelInput')} <b style={{ color: '#76e6ff' }}>↑{compact(summary?.lifetimeInputTokens || 0)}</b></span>
                <span>· {t('hud.dailyModelInputPeak')} <b style={{ color: '#45c8e7' }}>↑{compact(summary?.peakInputTokens || 0)}</b></span>
                <span>· {t('hud.totalModelOutput')} <b style={{ color: '#d6a7ff' }}>↓{compact(summary?.lifetimeOutputTokens || 0)}</b></span>
                <span>· {t('hud.dailyOutputPeak')} <b style={{ color: '#c47eff' }}>↓{compact(summary?.peakOutputTokens || 0)}</b></span>
              </div>

              <ActivityGrid
                weeks={weeks}
                monthLabels={monthLabels}
                peak={calendarPeak}
                metric="characters"
                selectedDay={selectedDay}
                canSelect={account.isAdmin}
                onSelect={(cell) => setSelectedDay({ day: cell.day, charCount: cell.charCount, inputTokens: cell.inputTokens, outputTokens: cell.outputTokens })}
              />

              <ActivityGrid
                weeks={weeks}
                monthLabels={monthLabels}
                peak={inputTokenCalendarPeak}
                metric="modelInput"
                selectedDay={selectedDay}
                canSelect={account.isAdmin}
                onSelect={(cell) => setSelectedDay({ day: cell.day, charCount: cell.charCount, inputTokens: cell.inputTokens, outputTokens: cell.outputTokens })}
              />

              <ActivityGrid
                weeks={weeks}
                monthLabels={monthLabels}
                peak={outputCalendarPeak}
                metric="output"
                selectedDay={selectedDay}
                canSelect={account.isAdmin}
                onSelect={(cell) => setSelectedDay({ day: cell.day, charCount: cell.charCount, inputTokens: cell.inputTokens, outputTokens: cell.outputTokens })}
              />

              <div style={{ minHeight: 26, display: 'flex', alignItems: 'center', marginTop: 3 }}>
                {account.isAdmin && selectedDay && (
                  <div aria-live="polite" style={{ color: '#dce7e4', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: '#9deeff' }}>
                      {new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(parseDay(selectedDay.day))}
                    </span>
                    <span style={{ color: 'rgba(170,226,220,0.55)', margin: '0 8px' }}>·</span>
                    <strong style={{ color: '#ffe29a', fontSize: 13 }}>{selectedDay.charCount.toLocaleString()}</strong>
                    <span style={{ color: '#a9b1b2', marginLeft: 5 }}>{t('hud.characters')}</span>
                    <span style={{ color: 'rgba(170,226,220,0.55)', margin: '0 8px' }}>·</span>
                    <strong style={{ color: '#76e6ff', fontSize: 13 }}>↑{selectedDay.inputTokens.toLocaleString()}</strong>
                    <span style={{ color: '#a9b1b2', marginLeft: 5 }}>{t('hud.inputTokens')}</span>
                    <span style={{ color: 'rgba(170,226,220,0.55)', margin: '0 8px' }}>·</span>
                    <strong style={{ color: '#c47eff', fontSize: 13 }}>↓{selectedDay.outputTokens.toLocaleString()}</strong>
                    <span style={{ color: '#a9b1b2', marginLeft: 5 }}>{t('hud.outputTokens')}</span>
                  </div>
                )}
              </div>

            </>
          )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
