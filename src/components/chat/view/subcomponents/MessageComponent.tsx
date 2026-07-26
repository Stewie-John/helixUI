import React, { memo, useMemo, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type {
  ChatMessage,
  ClaudePermissionSuggestion,
  PermissionGrantResult,
  Provider,
} from '../../types/types';
import { Markdown } from './Markdown';
import { formatUsageLimitText } from '../../utils/chatFormatting';
import { getClaudePermissionSuggestion } from '../../utils/chatPermissions';
import { getProviderLabel } from '../../utils/providerLabels';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import type { Project } from '../../../../types/app';
import { ToolRenderer, shouldHideToolResult } from '../../tools';
import { useDeviceSettings } from '../../../../hooks/useDeviceSettings';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface MessageComponentProps {
  message: ChatMessage;
  index: number;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
  onDeleteMessage?: (message: ChatMessage) => void;
  onEditMessage?: (message: ChatMessage, newContent: string) => void;
  onStartNewSession?: () => void;
  // 多账号场景：调用方按消息归属解析得到的"提问者头像"，由 ChatMessagesPane 注入
  userAvatarUrl?: string | null;
}

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

type PermissionGrantState = 'idle' | 'granted' | 'error';

function isTerminalCommandTool(toolName?: string) {
  const normalized = String(toolName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'bash'
    || normalized === 'exec'
    || normalized === 'wait'
    || normalized.endsWith('execcommand');
}

function getTerminalOutputPreview(toolResult: any) {
  const stringifyOutput = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          return stringifyOutput(record.text ?? record.content ?? record.output ?? record.message);
        }
        return '';
      }).filter(Boolean).join('\n');
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const nested = record.text ?? record.content ?? record.output ?? record.message;
      if (nested !== undefined && nested !== value) return stringifyOutput(nested);
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    }
    return value == null ? '' : String(value);
  };
  const raw = [toolResult?.content, toolResult?.output, toolResult?.message]
    .map(stringifyOutput)
    .find((value) => value.trim());
  const lines = typeof raw === 'string'
    ? raw.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean)
    : [];

  const longestLine = lines.reduce((longest, line) => Math.max(longest, line.length), 0);
  const averageLineLength = lines.length > 0
    ? lines.reduce((total, line) => total + line.length, 0) / lines.length
    : 0;
  // Minified bundles and generated blobs are technically one line, so a line-count
  // limit alone can still render several screens of unreadable output.
  const isDenseOutput = typeof raw === 'string'
    && raw.length > 400
    && (longestLine > 300 || averageLineLength > 240);
  const truncateLine = (line: string) => line.length > 320 ? `${line.slice(0, 320)}...` : line;
  const conciseErrorLine = [...lines].reverse().find((line) =>
    line.length <= 500 && /(error|failed|exception|fatal|exit code|enoent|eacces|错误|失败|异常)/i.test(line)
  ) || lines.find((line) => line.length <= 500) || lines[0] || '';

  return {
    preview: lines.slice(0, 2).map(truncateLine),
    expanded: lines.slice(0, 3).map(truncateLine),
    remaining: Math.max(0, lines.length - 3),
    errorDetails: Array.from(new Set([
      lines[0],
      conciseErrorLine,
      lines[lines.length - 1],
    ].filter(Boolean))).slice(0, 3).map(truncateLine),
    total: lines.length,
    characters: typeof raw === 'string' ? raw.length : 0,
    isDenseOutput,
    conciseError: truncateLine(conciseErrorLine),
  };
}

function TerminalCommandErrorPreview({
  toolResult,
  permissionSuggestion,
  onGrantToolPermission,
  onShowSettings,
}: {
  toolResult: any;
  permissionSuggestion?: ClaudePermissionSuggestion | null;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  onShowSettings?: () => void;
}) {
  const { t } = useTranslation('chat');
  const preview = getTerminalOutputPreview(toolResult);
  const [grantState, setGrantState] = useState<PermissionGrantState>('idle');
  return (
    <div className="relative mt-2 p-3 rounded border scroll-mt-4 bg-red-50/50 dark:bg-red-950/10 border-red-200/60 dark:border-red-800/40 text-xs font-mono">
      <details>
        <summary className="relative flex items-center gap-1.5 cursor-pointer list-none">
          <span className="codex-terminal-error">✗</span>
          <span className="font-medium text-red-700 dark:text-red-300">{t('messageTypes.error')}</span>
          <span className="codex-terminal-command-meta">
            {t('terminalOutput.denseHidden', {
              lines: preview.total,
              characters: preview.characters.toLocaleString(),
            })}
          </span>
          <span className="codex-terminal-command-meta">▼</span>
        </summary>
        {preview.conciseError && (
          <div className="mt-1.5 text-red-900 dark:text-red-100 break-words">
            {preview.conciseError}
          </div>
        )}
        <div className="codex-terminal-command-output mt-2 whitespace-pre-wrap break-all">
          {preview.errorDetails.join('\n')}
          {preview.total > preview.errorDetails.length && (
            <div className="codex-terminal-command-meta mt-1">
              ... {preview.total - preview.errorDetails.length} more lines hidden
            </div>
          )}
        </div>
      </details>
      {permissionSuggestion && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-red-200/60 dark:border-red-800/60 pt-2 font-sans">
          <button
            type="button"
            onClick={() => {
              const result = onGrantToolPermission?.(permissionSuggestion);
              setGrantState(result?.success ? 'granted' : 'error');
            }}
            disabled={permissionSuggestion.isAllowed || grantState === 'granted' || !onGrantToolPermission}
            className="px-2.5 py-1 rounded border border-red-300/70 dark:border-red-800/60 text-red-700 dark:text-red-200 disabled:opacity-60"
          >
            {permissionSuggestion.isAllowed || grantState === 'granted'
              ? t('permissions.added')
              : t('permissions.grant', { tool: permissionSuggestion.toolName })}
          </button>
          {onShowSettings && (
            <button type="button" onClick={onShowSettings} className="text-red-700 dark:text-red-200 underline">
              {t('permissions.openSettings')}
            </button>
          )}
          {grantState === 'error' && (
            <span className="text-red-700 dark:text-red-200">{t('permissions.error')}</span>
          )}
        </div>
      )}
    </div>
  );
}

function getRepeatedProgressOutput(content: string) {
  if (content.length < 500) return null;
  const etaCount = content.match(/\bETA\s*:/gi)?.length || 0;
  const transferCount = content.match(/\b\d+(?:\.\d+)?(?:KiB|MiB|GiB|TiB)\s*\/\s*\d+(?:\.\d+)?(?:KiB|MiB|GiB|TiB)/gi)?.length || 0;
  const ariaRowCount = content.match(/\[#[a-z0-9]{4,}/gi)?.length || 0;
  const percentCount = content.match(/\(\d{1,3}%\)/g)?.length || 0;
  const updateCount = Math.max(etaCount, transferCount, ariaRowCount, percentCount);
  if (updateCount < 6 || (etaCount < 4 && transferCount < 4 && ariaRowCount < 4)) return null;

  const snapshots = content
    .replace(/\r\n|\r/g, '\n')
    .replace(/\s+(?=(?:\[#[a-z0-9]{4,}|\*\*\*\s*Download Progress Summary))/gi, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const truncate = (line: string) => line.length > 280 ? `${line.slice(0, 280)}...` : line;
  return {
    updateCount,
    characters: content.length,
    latest: snapshots.slice(-3).map(truncate),
  };
}

function RepeatedProgressPreview({ content }: { content: string }) {
  const { t } = useTranslation('chat');
  const progress = getRepeatedProgressOutput(content);
  if (!progress) return null;
  return (
    <details className="codex-terminal-command-result my-1 text-[11px] font-mono">
      <summary className="flex items-center gap-2 cursor-pointer list-none">
        <span className="codex-terminal-success">↻</span>
        <span className="codex-terminal-command-result-text">
          {t('terminalOutput.progressCompressed', {
            updates: progress.updateCount.toLocaleString(),
            characters: progress.characters.toLocaleString(),
          })}
        </span>
        <span className="codex-terminal-command-meta">▼</span>
      </summary>
      <div className="codex-terminal-command-output mt-1 ml-5 whitespace-pre-wrap break-all">
        {progress.latest.join('\n')}
      </div>
    </details>
  );
}

function TerminalCommandResultPreview({ toolResult }: { toolResult: any }) {
  const { t } = useTranslation('chat');
  const { preview, expanded, remaining, total, characters, isDenseOutput } = getTerminalOutputPreview(toolResult);
  const exitCode = Number(toolResult?.exitCode);
  const status = Number.isFinite(exitCode) && exitCode !== 0
    ? `exit ${exitCode}`
    : 'completed';
  const canExpand = total > 2;

  if (isDenseOutput) {
    return (
      <div className="codex-terminal-command-result ml-7 mt-1 flex items-center gap-2 text-[11px] font-mono">
        <span className={status === 'completed' ? 'codex-terminal-success' : 'codex-terminal-error'}>
          {status === 'completed' ? '✓' : '✗'}
        </span>
        <span className="codex-terminal-command-result-text">
          {t('terminalOutput.denseHidden', { lines: total, characters: characters.toLocaleString() })}
        </span>
      </div>
    );
  }

  return (
    <details className="codex-terminal-command-result ml-7 mt-1 text-[11px] font-mono">
      <summary className={`flex items-start gap-2 ${canExpand ? 'cursor-pointer' : 'cursor-default'} list-none`}>
        <span className={status === 'completed' ? 'codex-terminal-success' : 'codex-terminal-error'}>
          {status === 'completed' ? '✓' : '✗'}
        </span>
        <span className="codex-terminal-command-result-text">
          {preview.length > 0 ? preview.join('  ·  ') : status}
        </span>
        {canExpand && <span className="codex-terminal-command-meta">+{total - 2} lines</span>}
      </summary>
      {canExpand && (
        <div className="codex-terminal-command-output mt-1 ml-5 whitespace-pre-wrap">
          {expanded.join('\n')}
          {remaining > 0 && <div className="codex-terminal-command-meta mt-1">... {remaining} more lines hidden</div>}
        </div>
      )}
    </details>
  );
}

/* ── 发送中：三个跳动点（与微信风格一致） ─────────────────────── */
function PendingDots() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, paddingBottom: 4 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 5, height: 5, borderRadius: '50%',
          background: 'rgba(148,163,184,0.85)',
          display: 'inline-block',
          animation: `pending-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
      <style>{`
        @keyframes pending-bounce {
          0%,80%,100% { transform: translateY(0); opacity:.5; }
          40%          { transform: translateY(-5px); opacity:1; }
        }
      `}</style>
    </div>
  );
}

/* ── 发送失败：闪烁红三角 + 绿色重发按钮 ─────────────────────── */
function FailedIndicator({ onResend }: { onResend: () => void }) {
  const { t } = useTranslation('chat');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingBottom: 4 }}>
      {/* 绿色重发按钮（微信风格） */}
      <button
        type="button"
        onClick={onResend}
        title={t('editMessage.resend')}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 26, height: 26, borderRadius: '50%',
          background: '#22c55e', border: 'none', cursor: 'pointer',
          boxShadow: '0 0 6px rgba(34,197,94,0.5)',
          flexShrink: 0, transition: 'background 0.15s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#16a34a'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#22c55e'; }}
      >
        {/* 重发箭头图标 */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 .49-4.5" />
        </svg>
      </button>
      {/* 闪烁红色感叹号三角 */}
      <svg
        width="20" height="20" viewBox="0 0 24 24" fill="none"
        style={{ flexShrink: 0, animation: 'tech-blink 1.4s step-end infinite', willChange: 'opacity' }}
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          fill="rgba(220,38,38,0.90)" stroke="rgba(239,68,68,0.6)" strokeWidth="0.5" />
        <line x1="12" y1="9" x2="12" y2="13" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1" fill="#fff" />
      </svg>
    </div>
  );
}

// ── 压缩进度条组件（统一处理"进行中"和"完成"两种模式）────────────────────
interface CompactSummaryBarProps {
  mode: 'in-progress' | 'done';
}
const CompactSummaryBar = ({ mode }: CompactSummaryBarProps) => {
  const { t } = useTranslation('chat');
  const [progress, setProgress] = useState(0);
  const [isDone, setIsDone] = useState(false);
  const rafRef = useRef<number | null>(null);

  const labelCompacting = t('compactSummary.compacting');
  const labelDone = t('compactSummary.done');

  useEffect(() => {
    if (mode === 'done') {
      // 延迟一帧后从 0 动画到 100%（CSS transition 处理插值）
      const t1 = setTimeout(() => setProgress(100), 60);
      // transition 约 2.5s 后标记完成，切换绿色
      const t2 = setTimeout(() => setIsDone(true), 2700);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    } else {
      // 缓慢爬行到 ~85%（ease-out 曲线，约 25 秒）
      const startTime = Date.now();
      const maxP = 85;
      const duration = 25000;
      const tick = () => {
        const t = Math.min(1, (Date.now() - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 2);
        setProgress(Math.floor(eased * maxP));
        if (t < 1) rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    }
  }, [mode]);

  const finished = mode === 'done' && isDone;
  const barColor = finished
    ? 'linear-gradient(90deg,#00a854 0%,#00d87c 70%,#80ffcc 100%)'
    : 'linear-gradient(90deg,#0055cc 0%,#0099ff 50%,#00d9ff 85%,#aaf0ff 100%)';
  const textColor = finished ? 'rgba(0,210,120,0.9)' : 'rgba(0,180,255,0.85)';

  return (
    <div style={{
      display: 'inline-flex', flexDirection: 'column', gap: 6,
      minWidth: 220, maxWidth: 340,
      background: 'rgba(0,140,255,0.06)',
      border: '1px solid rgba(0,140,255,0.18)',
      borderRadius: 8, padding: '8px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ color: textColor, flexShrink: 0 }}>
          {finished
            ? <polyline points="20 6 9 17 4 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            : <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          }
        </svg>
        <span style={{ fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.03em', color: textColor }}>
          {finished ? labelDone : labelCompacting}
        </span>
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(0,180,255,0.45)', marginLeft: 'auto' }}>
          {progress}%
        </span>
      </div>
      <div style={{ height: 3, borderRadius: 2, background: 'rgba(0,140,255,0.12)', overflow: 'hidden', position: 'relative' }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, height: '100%',
          width: `${progress}%`,
          borderRadius: 2,
          background: barColor,
          transition: mode === 'done'
            ? 'width 2.5s cubic-bezier(0.2,0,0.5,1)'
            : 'width 0.4s ease',
          boxShadow: finished
            ? '0 0 6px 1px rgba(0,200,100,0.5)'
            : '0 0 6px 2px rgba(0,180,255,0.55)',
        }} />
      </div>
    </div>
  );
};

const MessageComponent = memo(({ message, index, prevMessage, createDiff, onFileOpen, onShowSettings, onGrantToolPermission, autoExpandTools, showRawParameters, showThinking, selectedProject, provider, onDeleteMessage, onEditMessage, onStartNewSession, userAvatarUrl }: MessageComponentProps) => {
  const { t } = useTranslation('chat');
  const avatarUrl = userAvatarUrl ?? null;
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const isGrouped = prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user') ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error'));
  const messageRef = React.useRef<HTMLDivElement | null>(null);
  const [isExpanded, setIsExpanded] = React.useState(false);
  const permissionSuggestion = getClaudePermissionSuggestion(message, provider);
  const [permissionGrantState, setPermissionGrantState] = React.useState<PermissionGrantState>('idle');
  const [messageCopied, setMessageCopied] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [isEditing, setIsEditing] = React.useState(false);
  const [editContent, setEditContent] = React.useState('');
  const terminalOutputPreview = useMemo(
    () => isTerminalCommandTool(message.toolName) && message.toolResult
      ? getTerminalOutputPreview(message.toolResult)
      : null,
    [message.toolName, message.toolResult]
  );


  React.useEffect(() => {
    setPermissionGrantState('idle');
  }, [permissionSuggestion?.entry, message.toolId]);

  React.useEffect(() => {
    const node = messageRef.current;
    if (!autoExpandTools || !node || !message.isToolUse || isMobile) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isExpanded) {
            setIsExpanded(true);
            // 注意：不直接操作 detail.open，那样会绕过 React 状态控制，
            // 导致 React reconcile 时把 open 纠正回 false，触发 onToggle(false)，
            // 将 userInteractedRef 锁死为 true+closed，使展开失效。
            // CollapsibleSection 的 open prop 已经由 autoExpandTools/defaultOpen 控制展开。
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(node);

    return () => {
      observer.unobserve(node);
    };
  }, [autoExpandTools, isExpanded, message.isToolUse]);

  const formattedTime = useMemo(() => {
    const date = new Date(message.timestamp);
    if (isNaN(date.getTime())) return '';
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const hms = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    // 24 小时以内：仅显示时分秒
    if (diffMs >= 0 && diffMs < 24 * 60 * 60 * 1000) return hms;
    const md = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    // 超过 24 小时但仍在本年：月日 时分秒（参考微信）
    if (date.getFullYear() === now.getFullYear()) return `${md} ${hms}`;
    // 跨年：年月日 时分秒
    return `${date.getFullYear()}-${md} ${hms}`;
  }, [message.timestamp]);
  const shouldHideThinkingMessage = Boolean(message.isThinking && !showThinking);

  if (shouldHideThinkingMessage) {
    return null;
  }

  // ── 上下文压缩进度条（in-chat 卡片）────────────────────────────────────────
  if (message.type === 'compact-progress') {
    const progress = Number(message.compactProgress ?? 0);
    const done = Boolean(message.compactDone);

    // progress===0 → Claude 原生压缩进行中，使用动画组件缓慢爬行
    if (progress === 0 && !done) {
      return (
        <div ref={messageRef} className="px-3 sm:px-0 py-1">
          <CompactSummaryBar mode="in-progress" />
        </div>
      );
    }

    // 非 Claude（Codex/Cursor/Gemini）事件驱动进度，CSS transition 处理跳变
    const labelCompacting = t('compactSummary.compacting');
    const labelDone = t('compactSummary.done');
    return (
      <div ref={messageRef} className="px-3 sm:px-0 py-1">
        <div style={{
          display: 'inline-flex', flexDirection: 'column', gap: 6,
          minWidth: 220, maxWidth: 340,
          background: 'rgba(0,140,255,0.06)',
          border: '1px solid rgba(0,140,255,0.18)',
          borderRadius: 8, padding: '8px 12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ color: done ? 'rgba(0,210,120,0.9)' : 'rgba(0,180,255,0.85)', flexShrink: 0 }}>
              {done
                ? <polyline points="20 6 9 17 4 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                : <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              }
            </svg>
            <span style={{ fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.03em', color: done ? 'rgba(0,210,120,0.9)' : 'rgba(0,180,255,0.85)' }}>
              {done ? labelDone : labelCompacting}
            </span>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(0,180,255,0.45)', marginLeft: 'auto' }}>
              {progress}%
            </span>
          </div>
          <div style={{ height: 3, borderRadius: 2, background: 'rgba(0,140,255,0.12)', overflow: 'hidden', position: 'relative' }}>
            <div style={{
              position: 'absolute', left: 0, top: 0, height: '100%',
              width: `${progress}%`, borderRadius: 2,
              background: done
                ? 'linear-gradient(90deg,#00a854 0%,#00d87c 70%,#80ffcc 100%)'
                : 'linear-gradient(90deg,#0055cc 0%,#0099ff 50%,#00d9ff 85%,#aaf0ff 100%)',
              transition: 'width 0.7s cubic-bezier(0.4,0,0.2,1)',
              boxShadow: done ? '0 0 6px 1px rgba(0,200,100,0.5)' : '0 0 6px 2px rgba(0,180,255,0.55)',
            }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={messageRef}
      className={`chat-message ${message.type} ${isGrouped ? 'grouped' : ''} ${message.type === 'user' ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'}`}
    >
      {message.type === 'user' ? (
        /* User message bubble on the right */
        <div className="flex items-end space-x-0 sm:space-x-3 w-full sm:w-auto sm:max-w-[85%] md:max-w-md lg:max-w-lg xl:max-w-xl">
          {/* 发送状态指示器（气泡左侧） */}
          {message.pending && <PendingDots />}
          {(message.sendFailed || message.deliveryStatus === 'failed') && (
            <FailedIndicator onResend={() => onEditMessage?.(message, String(message.content || ''))} />
          )}
          {/* wrapper：提供定位上下文，三角与气泡平级，不受 clip-path 剪裁 */}
          <div className="relative flex-1 sm:flex-initial">
          <div className={`relative ${message.queuedStatus ? 'bg-slate-600/90 ring-1 ring-slate-300/40' : message.isBtw ? (message.btwStatus === 'failed' ? 'bg-red-600/90 ring-1 ring-red-300/60' : 'bg-amber-500/90 ring-1 ring-amber-300/60') : 'bg-blue-600'} text-white rounded-2xl rounded-br-sm px-3 sm:px-4 py-2 shadow-sm w-full group`}>
            {message.queuedStatus && (
              <div className="text-xs mb-1 text-slate-100/80">Queued · sends after the current turn</div>
            )}
            {/* BTW 消息标签：诚实反映送达状态（送达后端 ≠ 当前回合一定立即读到）*/}
            {message.isBtw && (
              <div className={`text-xs mb-1 flex items-center gap-1 ${message.btwStatus === 'failed' ? 'text-red-100/90' : 'text-amber-100/80'}`}>
                <span>↩</span>
                <span>
                  {message.btwStatus === 'pending' && t('input.followup.sending')}
                  {message.btwStatus === 'sent' && t(message.provider === 'codex' ? 'input.followup.steered' : 'input.followup.delivered')}
                  {message.btwStatus === 'failed' && t('input.followup.failed')}
                  {!message.btwStatus && t('input.followup.delivered')}
                </span>
              </div>
            )}
            <div className="text-sm whitespace-pre-wrap break-words">
              {message.content}
            </div>
            {message.images && message.images.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {message.images.map((img, idx) => (
                  <img
                    key={img.name || idx}
                    src={img.data}
                    alt={img.name}
                    className="rounded-lg max-w-full h-auto cursor-pointer hover:opacity-90 transition-opacity"
                    onClick={() => window.open(img.data, '_blank')}
                  />
                ))}
              </div>
            )}
            {/* 内联编辑器（用户消息编辑模式） */}
            {isEditing ? (
              <div className="mt-2">
                <textarea
                  className="w-full bg-blue-500 text-white placeholder-blue-200 rounded-lg px-3 py-2 text-sm resize-none border border-blue-300 focus:outline-none focus:border-white"
                  rows={Math.min(10, editContent.split('\n').length + 1)}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if (editContent.trim()) {
                        setIsEditing(false);
                        onEditMessage?.(message, editContent.trim());
                      }
                    } else if (e.key === 'Escape') {
                      setIsEditing(false);
                    }
                  }}
                  autoFocus
                />
                <div className="flex justify-end gap-2 mt-1.5">
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="px-3 py-1 text-xs rounded-md bg-blue-400/60 hover:bg-blue-400 text-white transition-colors"
                  >
                    {t('editMessage.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (editContent.trim()) {
                        setIsEditing(false);
                        onEditMessage?.(message, editContent.trim());
                      }
                    }}
                    className="px-3 py-1 text-xs rounded-md bg-white text-blue-700 hover:bg-blue-50 font-medium transition-colors"
                  >
                    {t('editMessage.resend')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-1 mt-1 text-xs text-blue-100">
                {/* 删除按钮（垃圾桶） */}
                {onDeleteMessage && (
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(true)}
                    title={t('deleteMessage.delete')}
                    aria-label={t('deleteMessage.delete')}
                    className="opacity-60 hover:opacity-100 transition-opacity"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                    </svg>
                  </button>
                )}
                {/* 编辑按钮（铅笔） */}
                {onEditMessage && (
                  <button
                    type="button"
                    onClick={() => { setEditContent(String(message.content || '')); setIsEditing(true); }}
                    title={t('editMessage.edit')}
                    aria-label={t('editMessage.edit')}
                    className="opacity-60 hover:opacity-100 transition-opacity"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                )}
                {/* 复制按钮 */}
                <button
                  type="button"
                  onClick={() => {
                    const text = String(message.content || '');
                    if (!text) return;
                    copyTextToClipboard(text).then((success) => {
                      if (!success) return;
                      setMessageCopied(true);
                    });
                  }}
                  title={messageCopied ? t('copyMessage.copied') : t('copyMessage.copy')}
                  aria-label={messageCopied ? t('copyMessage.copied') : t('copyMessage.copy')}
                >
                  {messageCopied ? (
                    <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
                    </svg>
                  )}
                </button>
                <span>{formattedTime}</span>
              </div>
            )}
          </div>
          {/* 微信风格气泡尖角：与气泡平级，不受气泡 clip-path 剪裁 */}
          {!isEditing && (
            <div
              className="user-bubble-tail"
              style={{
                position: 'absolute',
                right: -12,
                bottom: 12,
                width: 0,
                height: 0,
                borderLeft: `12px solid ${message.isBtw ? 'rgba(245,158,11,0.9)' : '#2563eb'}`,
                borderTop: '8px solid transparent',
                borderBottom: '8px solid transparent',
              }}
            />
          )}
          </div>{/* end wrapper */}
          {!isGrouped && (
            <div className="hidden sm:flex w-8 h-8 rounded-full flex-shrink-0 overflow-hidden bg-blue-600 items-center justify-center text-white text-sm tech-user-avatar">
              {avatarUrl
                ? <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" />
                : 'U'
              }
            </div>
          )}
        </div>
      ) : message.isTaskNotification ? (
        /* Compact task notification on the left */
        <div className="w-full">
          <div className="flex items-center gap-2 py-0.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${message.taskStatus === 'completed' ? 'bg-green-400 dark:bg-green-500' : 'bg-amber-400 dark:bg-amber-500'}`} />
            <span className="text-xs text-gray-500 dark:text-gray-400">{message.content}</span>
          </div>
        </div>
      ) : (
        /* Claude/Error/Tool messages on the left */
        <div className="w-full">
          {!isGrouped && !message.isCompactSummary && (
            <div className="flex items-center space-x-3 mb-2">
              {message.type === 'error' ? (
                <div className="w-8 h-8 bg-red-600 rounded-full flex items-center justify-center text-white text-sm flex-shrink-0">
                  !
                </div>
              ) : message.type === 'tool' ? (
                <div className="w-8 h-8 bg-gray-600 dark:bg-gray-700 rounded-full flex items-center justify-center text-white text-sm flex-shrink-0">
                  🔧
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm flex-shrink-0 p-1">
                  <SessionProviderLogo provider={provider} className="w-full h-full" />
                </div>
              )}
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {message.type === 'error' ? t('messageTypes.error') : message.type === 'tool' ? t('messageTypes.tool') : getProviderLabel(provider)}
              </div>
            </div>
          )}

          <div className="w-full">

            {message.isToolUse ? (
              <>
                <div className="flex flex-col">
                  <div className="flex flex-col">
                    <Markdown className="codex-terminal-prose prose prose-sm max-w-none dark:prose-invert" messageTimestamp={message.timestamp} onFileOpen={onFileOpen}>
                      {String(message.displayText || '')}
                    </Markdown>
                  </div>
                </div>

                {message.toolInput && (
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                    onFileOpen={onFileOpen}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                    autoExpandTools={autoExpandTools}
                    showRawParameters={showRawParameters}
                    rawToolInput={typeof message.toolInput === 'string' ? message.toolInput : undefined}
                    isSubagentContainer={message.isSubagentContainer}
                    subagentState={message.subagentState}
                  />
                )}

                {isTerminalCommandTool(message.toolName) && message.toolResult && !message.toolResult.isError && (
                  <TerminalCommandResultPreview toolResult={message.toolResult} />
                )}

                {/* Tool Result Section */}
                {message.toolResult && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
                  message.toolResult.isError ? (
                    terminalOutputPreview ? (
                      <div id={`tool-result-${message.toolId}`}>
                        <TerminalCommandErrorPreview
                          toolResult={message.toolResult}
                          permissionSuggestion={permissionSuggestion}
                          onGrantToolPermission={onGrantToolPermission}
                          onShowSettings={onShowSettings}
                        />
                      </div>
                    ) : (
                    // Error results - red error box with content
                    <div
                      id={`tool-result-${message.toolId}`}
                      className="relative mt-2 p-3 rounded border scroll-mt-4 bg-red-50/50 dark:bg-red-950/10 border-red-200/60 dark:border-red-800/40"
                    >
                      <div className="relative flex items-center gap-1.5 mb-2">
                        <svg className="w-4 h-4 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="text-xs font-medium text-red-700 dark:text-red-300">{t('messageTypes.error')}</span>
                      </div>
                      <div className="relative text-sm text-red-900 dark:text-red-100">
                        <Markdown className="codex-terminal-prose prose prose-sm max-w-none prose-red dark:prose-invert" messageTimestamp={message.timestamp} onFileOpen={onFileOpen}>
                          {String(message.toolResult.content || '')}
                        </Markdown>
                        {permissionSuggestion && (
                          <div className="mt-4 border-t border-red-200/60 dark:border-red-800/60 pt-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!onGrantToolPermission) return;
                                  const result = onGrantToolPermission(permissionSuggestion);
                                  if (result?.success) {
                                    setPermissionGrantState('granted');
                                  } else {
                                    setPermissionGrantState('error');
                                  }
                                }}
                                disabled={permissionSuggestion.isAllowed || permissionGrantState === 'granted'}
                                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${permissionSuggestion.isAllowed || permissionGrantState === 'granted'
                                  ? 'bg-green-100 dark:bg-green-900/30 border-green-300/70 dark:border-green-800/60 text-green-800 dark:text-green-200 cursor-default'
                                  : 'bg-white/80 dark:bg-gray-900/40 border-red-300/70 dark:border-red-800/60 text-red-700 dark:text-red-200 hover:bg-white dark:hover:bg-gray-900/70'
                                  }`}
                              >
                                {permissionSuggestion.isAllowed || permissionGrantState === 'granted'
                                  ? t('permissions.added')
                                  : t('permissions.grant', { tool: permissionSuggestion.toolName })}
                              </button>
                              {onShowSettings && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); onShowSettings(); }}
                                  className="text-xs text-red-700 dark:text-red-200 underline hover:text-red-800 dark:hover:text-red-100"
                                >
                                  {t('permissions.openSettings')}
                                </button>
                              )}
                            </div>
                            <div className="mt-2 text-xs text-red-700/90 dark:text-red-200/80">
                              {t('permissions.addTo', { entry: permissionSuggestion.entry })}
                            </div>
                            {permissionGrantState === 'error' && (
                              <div className="mt-2 text-xs text-red-700 dark:text-red-200">
                                {t('permissions.error')}
                              </div>
                            )}
                            {(permissionSuggestion.isAllowed || permissionGrantState === 'granted') && (
                              <div className="mt-2 text-xs text-green-700 dark:text-green-200">
                                {t('permissions.retry')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    )
                  ) : (
                    // Non-error results - route through ToolRenderer (single source of truth)
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolRenderer
                        toolName={message.toolName || 'UnknownTool'}
                        toolInput={message.toolInput}
                        toolResult={message.toolResult}
                        toolId={message.toolId}
                        mode="result"
                        onFileOpen={onFileOpen}
                        createDiff={createDiff}
                        selectedProject={selectedProject}
                        autoExpandTools={autoExpandTools}
                      />
                    </div>
                  )
                )}
              </>
            ) : message.isInteractivePrompt ? (
              // Special handling for interactive prompts
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-amber-900 dark:text-amber-100 text-base mb-3">
                      {t('interactive.title')}
                    </h4>
                    {(() => {
                      const lines = (message.content || '').split('\n').filter((line) => line.trim());
                      const questionLine = lines.find((line) => line.includes('?')) || lines[0] || '';
                      const options: InteractiveOption[] = [];

                      // Parse the menu options
                      lines.forEach((line) => {
                        // Match lines like "❯ 1. Yes" or "  2. No"
                        const optionMatch = line.match(/[❯\s]*(\d+)\.\s+(.+)/);
                        if (optionMatch) {
                          const isSelected = line.includes('❯');
                          options.push({
                            number: optionMatch[1],
                            text: optionMatch[2].trim(),
                            isSelected
                          });
                        }
                      });

                      return (
                        <>
                          <p className="text-sm text-amber-800 dark:text-amber-200 mb-4">
                            {questionLine}
                          </p>

                          {/* Option buttons */}
                          <div className="space-y-2 mb-4">
                            {options.map((option) => (
                              <button
                                key={option.number}
                                className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all ${option.isSelected
                                  ? 'bg-amber-600 dark:bg-amber-700 text-white border-amber-600 dark:border-amber-700 shadow-md'
                                  : 'bg-white dark:bg-gray-800 text-amber-900 dark:text-amber-100 border-amber-300 dark:border-amber-700'
                                  } cursor-not-allowed opacity-75`}
                                disabled
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${option.isSelected
                                    ? 'bg-white/20'
                                    : 'bg-amber-100 dark:bg-amber-800/50'
                                    }`}>
                                    {option.number}
                                  </span>
                                  <span className="text-sm sm:text-base font-medium flex-1">
                                    {option.text}
                                  </span>
                                  {option.isSelected && (
                                    <span className="text-lg">❯</span>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>

                          <div className="bg-amber-100 dark:bg-amber-800/30 rounded-lg p-3">
                            <p className="text-amber-900 dark:text-amber-100 text-sm font-medium mb-1">
                              {t('interactive.waiting')}
                            </p>
                            <p className="text-amber-800 dark:text-amber-200 text-xs">
                              {t('interactive.instruction')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : message.isCompactSummary ? (
              /* Claude 原生压缩完成：0%→100% 动画后转绿，替代丑陋的 details 折叠块 */
              <CompactSummaryBar mode="done" />
            ) : message.isThinking ? (
              /* Thinking messages - collapsible by default */
              <div className="codex-terminal-body text-sm text-gray-700 dark:text-gray-300">
                <details className="group">
                  <summary className="cursor-pointer text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 font-medium flex items-center gap-2">
                    <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span>{t('thinking.emoji')}</span>
                  </summary>
                  <div className="mt-2 pl-4 border-l-2 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 text-sm">
                    <Markdown className="codex-terminal-prose prose prose-sm max-w-none dark:prose-invert prose-gray" messageTimestamp={message.timestamp} onFileOpen={onFileOpen}>
                      {message.content}
                    </Markdown>
                  </div>
                </details>
              </div>
            ) : (
              <div className="codex-terminal-body text-sm text-gray-700 dark:text-gray-300">
                {/* Thinking accordion for reasoning */}
                {showThinking && message.reasoning && (
                  <details className="mb-3">
                    <summary className="cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 font-medium">
                      {t('thinking.emoji')}
                    </summary>
                    <div className="mt-2 pl-4 border-l-2 border-gray-300 dark:border-gray-600 italic text-gray-600 dark:text-gray-400 text-sm">
                      <div className="whitespace-pre-wrap">
                        {String(message.reasoning)}
                      </div>
                    </div>
                  </details>
                )}

                {(() => {
                  const content = formatUsageLimitText(String(message.content || ''));

                  // Detect if content is pure JSON (starts with { or [)
                  const trimmedContent = content.trim();
                  if ((trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) &&
                    (trimmedContent.endsWith('}') || trimmedContent.endsWith(']'))) {
                    try {
                      const parsed = JSON.parse(trimmedContent);
                      const formatted = JSON.stringify(parsed, null, 2);

                      return (
                        <div className="my-2">
                          <div className="flex items-center gap-2 mb-2 text-sm text-gray-600 dark:text-gray-400">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">{t('json.response')}</span>
                          </div>
                          <div className="bg-gray-800 dark:bg-gray-900 border border-gray-600/30 dark:border-gray-700 rounded-lg overflow-hidden">
                            <pre className="p-4 overflow-x-auto">
                              <code className="text-gray-100 dark:text-gray-200 text-sm font-mono block whitespace-pre">
                                {formatted}
                              </code>
                            </pre>
                          </div>
                        </div>
                      );
                    } catch {
                      // Not valid JSON, fall through to normal rendering
                    }
                  }

                  // Normal rendering for non-JSON content
                  return message.type === 'assistant' ? (
                    getRepeatedProgressOutput(content) ? (
                      <RepeatedProgressPreview content={content} />
                    ) : (
                      <Markdown className="codex-terminal-prose prose prose-sm max-w-none dark:prose-invert prose-gray" messageTimestamp={message.timestamp} onFileOpen={onFileOpen}>
                        {content}
                      </Markdown>
                    )
                  ) : (
                    <div className="whitespace-pre-wrap">
                      {content}
                    </div>
                  );
                })() as any}

                {/* 图片尺寸超限错误：提示用户新建会话继续对话 */}
                {message.isImageDimensionError && onStartNewSession && (
                  <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/40 rounded-lg">
                    <p className="text-xs text-amber-800 dark:text-amber-300 mb-2">
                      {t('imageDimensionError.notice')}
                    </p>
                    <button
                      type="button"
                      onClick={onStartNewSession}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-600 hover:bg-amber-700 text-white transition-colors"
                    >
                      {t('imageDimensionError.startNewSession')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Claude 消息底部操作栏：工具调用消息不显示，只在文本消息末尾显示 */}
            {!message.isToolUse && !message.isCompactSummary && (isEditing ? (
              <div className="mt-2">
                <textarea
                  className="w-full bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-100 rounded-lg px-3 py-2 text-sm resize-none border border-gray-300 dark:border-gray-600 focus:outline-none focus:border-blue-400"
                  rows={Math.min(10, editContent.split('\n').length + 1)}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setIsEditing(false);
                  }}
                  autoFocus
                />
                <div className="flex justify-end gap-2 mt-1.5">
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="px-3 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    {t('editMessage.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (editContent.trim()) {
                        setIsEditing(false);
                        onEditMessage?.(message, editContent.trim());
                      }
                    }}
                    className="px-3 py-1 text-xs rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
                  >
                    {t('editMessage.save')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">
                {/* 删除按钮（垃圾桶） */}
                {onDeleteMessage && (
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(true)}
                    title={t('deleteMessage.delete')}
                    aria-label={t('deleteMessage.delete')}
                    className="opacity-50 hover:opacity-100 hover:text-red-400 transition-all"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                    </svg>
                  </button>
                )}
                {/* 编辑按钮（铅笔） */}
                {onEditMessage && (
                  <button
                    type="button"
                    onClick={() => { setEditContent(String(message.content || '')); setIsEditing(true); }}
                    title={t('editMessage.edit')}
                    aria-label={t('editMessage.edit')}
                    className="opacity-50 hover:opacity-100 transition-opacity"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                )}
                {/* 复制按钮 */}
                <button
                  type="button"
                  onClick={() => {
                    const text = String(message.content || '');
                    if (!text) return;
                    copyTextToClipboard(text).then((success) => {
                      if (!success) return;
                      setMessageCopied(true);
                    });
                  }}
                  title={messageCopied ? t('copyMessage.copied') : t('copyMessage.copy')}
                  aria-label={messageCopied ? t('copyMessage.copied') : t('copyMessage.copy')}
                  className="opacity-50 hover:opacity-100 transition-opacity"
                >
                  {messageCopied ? (
                    <svg className="w-3.5 h-3.5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
                    </svg>
                  )}
                </button>
                {!isGrouped && <span>{formattedTime}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 删除确认对话框（固定居中弹窗） */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setShowDeleteConfirm(false)}
        >
          {/* 半透明背景遮罩 */}
          <div className="absolute inset-0 bg-black/50" />
          {/* 弹窗主体 */}
          <div
            className="relative bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6 mx-4 max-w-sm w-full border border-gray-200 dark:border-gray-700"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 标题行 */}
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-red-600 dark:text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                {t('deleteMessage.confirmTitle')}
              </h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
              {t('deleteMessage.confirmText')}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                {t('deleteMessage.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  onDeleteMessage?.(message);
                }}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                {t('deleteMessage.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default MessageComponent;
