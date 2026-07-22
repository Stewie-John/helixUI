import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { Project } from '../../../types/app';
import {
  CODEX_DEVICE_AUTH_URL,
  TERMINAL_INIT_DELAY_MS,
  TERMINAL_OPTIONS,
  TERMINAL_RESIZE_DELAY_MS,
} from '../constants/constants';
import { isCodexLoginCommand } from '../utils/auth';
import { sendSocketMessage } from '../utils/socket';
import { ensureXtermFocusStyles } from '../utils/terminalStyles';
import { copyTextToClipboard } from '../../../utils/clipboard';

type UseShellTerminalOptions = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  selectedProject: Project | null | undefined;
  minimal: boolean;
  isRestarting: boolean;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  authUrlRef: MutableRefObject<string>;
  copyAuthUrlToClipboard: (url?: string) => Promise<boolean>;
  closeSocket: () => void;
  isUserScrollingShellRef: MutableRefObject<boolean>;
};

type UseShellTerminalResult = {
  isInitialized: boolean;
  clearTerminalScreen: () => void;
  disposeTerminal: () => void;
};

export function useShellTerminal({
  terminalContainerRef,
  terminalRef,
  fitAddonRef,
  wsRef,
  selectedProject,
  minimal,
  isRestarting,
  initialCommandRef,
  isPlainShellRef,
  authUrlRef,
  copyAuthUrlToClipboard,
  closeSocket,
  isUserScrollingShellRef,
}: UseShellTerminalOptions): UseShellTerminalResult {
  const [isInitialized, setIsInitialized] = useState(false);
  const resizeTimeoutRef = useRef<number | null>(null);
  const selectedProjectKey = selectedProject?.fullPath || selectedProject?.path || '';
  const hasSelectedProject = Boolean(selectedProject);
  const lastTerminalTouchYRef = useRef<number | null>(null);
  const shellScrollTargetsRef = useRef<Set<HTMLElement>>(new Set());
  const terminalSizeRef = useRef({ width: 0, height: 0 });
  const TERMINAL_SCROLL_EPSILON_PX = 24;
  const isTerminalAtBottom = useCallback(() => {
    const viewport = (
      terminalRef.current?.element?.querySelector('.xterm-viewport')
      || terminalContainerRef.current?.querySelector('.xterm-viewport')
    ) as HTMLElement | null;
    if (!viewport) return true;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= TERMINAL_SCROLL_EPSILON_PX;
  }, [terminalContainerRef]);

  useEffect(() => {
    ensureXtermFocusStyles();
  }, []);

  const clearTerminalScreen = useCallback(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.clear();
    terminalRef.current.write('\x1b[2J\x1b[H');
  }, [terminalRef]);

  const disposeTerminal = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    setIsInitialized(false);
  }, [fitAddonRef, terminalRef]);

  useEffect(() => {
    if (!terminalContainerRef.current || !hasSelectedProject || isRestarting || terminalRef.current) {
      return;
    }

    const nextTerminal = new Terminal(TERMINAL_OPTIONS);
    terminalRef.current = nextTerminal;

    const nextFitAddon = new FitAddon();
    fitAddonRef.current = nextFitAddon;
    nextTerminal.loadAddon(nextFitAddon);

    // Avoid wrapped partial links in compact login flows.
    if (!minimal) {
      nextTerminal.loadAddon(new WebLinksAddon());
    }

    try {
      nextTerminal.loadAddon(new WebglAddon());
    } catch {
      console.warn('[Shell] WebGL renderer unavailable, using Canvas fallback');
    }

    nextTerminal.open(terminalContainerRef.current);

    const isCopyShortcut = (event: KeyboardEvent) =>
      event.type === 'keydown' &&
      !event.altKey &&
      ((event.metaKey && !event.ctrlKey) || (event.ctrlKey && event.shiftKey && !event.metaKey)) &&
      (event.key?.toLowerCase() === 'c' || event.code === 'KeyC');

    // Only xterm's live selection counts as terminal copy text. Browser and
    // cached selections can outlive their highlight and must not swallow SIGINT.
    const getTerminalSelectionText = () => nextTerminal.getSelection();

    const sendTerminalPasteText = (text: string) => {
      if (text) {
        sendSocketMessage(wsRef.current, { type: 'input', data: text });
      }
    };

    const isTerminalKeyboardContext = (event: KeyboardEvent) =>
      Boolean(
        isCopyShortcut(event)
          && terminalContainerRef.current
          && (
            terminalContainerRef.current.contains(event.target as Node) ||
            terminalContainerRef.current.contains(document.activeElement) ||
            nextTerminal.element?.contains(document.activeElement) ||
            nextTerminal.textarea === document.activeElement
          ),
      );

    const handleCopyShortcut = async (event: KeyboardEvent) => {
      const selectionText = getTerminalSelectionText();
      if (!selectionText) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      await copyTextToClipboard(selectionText);
      return true;
    };

    const maybeHandleCopyShortcut = (event: KeyboardEvent) => {
      if (!isCopyShortcut(event)) {
        return false;
      }

      if (!isTerminalKeyboardContext(event)) {
        return false;
      }

      void handleCopyShortcut(event);
      return true;
    };

    nextTerminal.attachCustomKeyEventHandler((event) => {
      const activeAuthUrl = isCodexLoginCommand(initialCommandRef.current)
        ? CODEX_DEVICE_AUTH_URL
        : authUrlRef.current;

      if (
        event.type === 'keydown' &&
        minimal &&
        isPlainShellRef.current &&
        activeAuthUrl &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key?.toLowerCase() === 'c'
      ) {
        event.preventDefault();
        event.stopPropagation();
        void copyAuthUrlToClipboard(activeAuthUrl);
        return false;
      }

      if (event.type !== 'keydown') return true;

      const key = event.key?.toLowerCase();
      const isCtrlOrMeta = event.ctrlKey || event.metaKey;

      // Ctrl-C is always SIGINT, matching native terminals. Copy remains
      // available through Cmd-C on macOS and Ctrl-Shift-C elsewhere.
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (key === 'c' || event.code === 'KeyC') &&
        event.type === 'keydown'
      ) {
        event.preventDefault();
        event.stopPropagation();
        sendSocketMessage(wsRef.current, { type: 'input', data: '\x03' });
        return false;
      }

      // ── Ctrl/Cmd + V：交给浏览器触发原生 paste 事件 ────────────────
      // 在 HTTP 内网地址和移动浏览器里 Clipboard API 经常不可用；原生 paste
      // 事件能拿到 clipboardData，下面的 paste 监听负责发送给终端。
      if (isCtrlOrMeta && (key === 'v' || event.code === 'KeyV')) {
        return true;
      }

      // Cmd+A selects terminal output on macOS. Ctrl+A remains untouched so
      // readline/TUI programs receive the native "move to line start" control.
      if (event.metaKey && !event.ctrlKey && (key === 'a' || event.code === 'KeyA')) {
        event.preventDefault();
        event.stopPropagation();
        nextTerminal.selectAll();
        return false;
      }

      // ── Cmd+C / Ctrl+Shift+C：复制当前终端选区 ─────────────────────
      if (maybeHandleCopyShortcut(event)) {
        return false;
      }

      return true;
    });

    const handleTerminalCopyShortcut = (event: KeyboardEvent) => {
      if (!terminalContainerRef.current || !isCopyShortcut(event) || !isTerminalKeyboardContext(event)) {
        return;
      }

      const selectionText = getTerminalSelectionText();
      if (!selectionText) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void copyTextToClipboard(selectionText);
    };

    const handleTerminalPaste = (event: ClipboardEvent) => {
      if (!terminalContainerRef.current) {
        return;
      }

      const target = event.target as Node | null;
      const inTerminal =
        (target && terminalContainerRef.current.contains(target)) ||
        terminalContainerRef.current.contains(document.activeElement);

      if (!inTerminal) {
        return;
      }

      const text = event.clipboardData?.getData('text/plain') || event.clipboardData?.getData('text') || '';
      if (!text) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      sendTerminalPasteText(text);
    };

    const handleShellScrollStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      lastTerminalTouchYRef.current = touch ? touch.clientY : null;
    };

    const handleShellScrollUpdate = () => {
      isUserScrollingShellRef.current = true;
      if (isTerminalAtBottom()) {
        isUserScrollingShellRef.current = false;
      }
    };

    const handleShellWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) {
        isUserScrollingShellRef.current = true;
      }
    };

    const handleShellTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      const previousY = lastTerminalTouchYRef.current;
      if (previousY !== null && previousY !== touch.clientY) {
        isUserScrollingShellRef.current = true;
      }
      lastTerminalTouchYRef.current = touch.clientY;
    };

    const registerScrollTarget = (target: HTMLElement | null) => {
      if (!target || shellScrollTargetsRef.current.has(target)) {
        return;
      }

      target.addEventListener('wheel', handleShellWheel, { passive: true });
      target.addEventListener('scroll', handleShellScrollUpdate, { passive: true });
      target.addEventListener('touchstart', handleShellScrollStart, { passive: true });
      target.addEventListener('touchmove', handleShellTouchMove, { passive: true });
      shellScrollTargetsRef.current.add(target);
    };

    const unregisterScrollTargets = () => {
      shellScrollTargetsRef.current.forEach((target) => {
        target.removeEventListener('wheel', handleShellWheel);
        target.removeEventListener('scroll', handleShellScrollUpdate);
        target.removeEventListener('touchstart', handleShellScrollStart);
        target.removeEventListener('touchmove', handleShellTouchMove);
      });
      shellScrollTargetsRef.current.clear();
    };

    registerScrollTarget(terminalContainerRef.current);
    registerScrollTarget(terminalRef.current.element?.querySelector('.xterm-viewport') as HTMLElement | null);
    registerScrollTarget(terminalRef.current.element?.querySelector('.xterm-screen') as HTMLElement | null);

    terminalContainerRef.current.addEventListener('keydown', handleTerminalCopyShortcut, true);
    terminalContainerRef.current.addEventListener('paste', handleTerminalPaste, true);
    nextTerminal.textarea?.addEventListener('paste', handleTerminalPaste, true);
    document.addEventListener('keydown', handleTerminalCopyShortcut, true);

    // 等待浏览器完成布局 + WebGL 渲染器初始化字体度量，再 fit()、再标记初始化完成
    // 此时才触发 WebSocket 连接，确保 init 消息携带正确的 cols/rows
    window.setTimeout(() => {
      const currentFitAddon = fitAddonRef.current;
      const currentTerminal = terminalRef.current;
      if (!currentFitAddon || !currentTerminal) {
        return;
      }

      currentFitAddon.fit();
      sendSocketMessage(wsRef.current, {
        type: 'resize',
        cols: currentTerminal.cols,
        rows: currentTerminal.rows,
      });
      setIsInitialized(true);
    }, TERMINAL_INIT_DELAY_MS);

    const dataSubscription = nextTerminal.onData((data) => {
      sendSocketMessage(wsRef.current, {
        type: 'input',
        data,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = window.setTimeout(() => {
        const currentFitAddon = fitAddonRef.current;
        const currentTerminal = terminalRef.current;
        const container = terminalContainerRef.current;
        if (!currentFitAddon || !currentTerminal || !container) {
          return;
        }
        const width = Math.round(container.clientWidth);
        const height = Math.round(container.clientHeight);
        if (width === terminalSizeRef.current.width && height === terminalSizeRef.current.height) return;
        terminalSizeRef.current = { width, height };
        const previousViewportLine = currentTerminal.buffer.active.viewportY;
        currentFitAddon.fit();
        if (isUserScrollingShellRef.current) {
          currentTerminal.scrollToLine(Math.min(previousViewportLine, currentTerminal.buffer.active.baseY));
        }
        sendSocketMessage(wsRef.current, {
          type: 'resize',
          cols: currentTerminal.cols,
          rows: currentTerminal.rows,
        });
      }, Math.max(120, TERMINAL_RESIZE_DELAY_MS));
    });

    resizeObserver.observe(terminalContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      terminalContainerRef.current?.removeEventListener('keydown', handleTerminalCopyShortcut, true);
      terminalContainerRef.current?.removeEventListener('paste', handleTerminalPaste, true);
      nextTerminal.textarea?.removeEventListener('paste', handleTerminalPaste, true);
      document.removeEventListener('keydown', handleTerminalCopyShortcut, true);
      unregisterScrollTargets();
      dataSubscription.dispose();
      closeSocket();
      disposeTerminal();
    };
  }, [
    authUrlRef,
    closeSocket,
    copyAuthUrlToClipboard,
    disposeTerminal,
    fitAddonRef,
    initialCommandRef,
    isPlainShellRef,
    isRestarting,
    minimal,
    hasSelectedProject,
    selectedProjectKey,
    terminalContainerRef,
    terminalRef,
    wsRef,
    isTerminalAtBottom,
    isUserScrollingShellRef,
  ]);

  return {
    isInitialized,
    clearTerminalScreen,
    disposeTerminal,
  };
}
