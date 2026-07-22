import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { AUTH_TOKEN_INVALID_EVENT } from '../utils/api';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  latestMessage: any | null;
  isConnected: boolean;
  // 入站消息队列：解决 React 18 自动批处理导致的消息丢失问题
  incomingMsgQueueRef: React.MutableRefObject<any[]>;
  incomingMsgVersion: number;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

const getClientInstanceId = () => {
  const storageKey = 'cloudcli-client-instance-id';
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const generated = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(storageKey, generated);
    return generated;
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
};

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const isJwtExpired = (token: string | null) => {
  if (!token || IS_PLATFORM) return false;
  try {
    const [, payload] = token.split('.');
    if (!payload) return false;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(normalized));
    return typeof decoded.exp === 'number' && decoded.exp * 1000 <= Date.now() + 5000;
  } catch {
    return false;
  }
};

const notifyInvalidAuthToken = () => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('auth-token');
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_INVALID_EVENT));
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const clientInstanceIdRef = useRef(getClientInstanceId());
  const wsRef = useRef<WebSocket | null>(null);
  // 当前「最新」的 socket。每次 connect() 新建 socket 时更新。
  // 旧 socket 被取代后，其延迟派发的 onclose/onopen/onerror 事件必须被忽略，
  // 否则旧 socket 的 onclose 会把已经恢复的 isConnected 又改回 false → 断连横幅卡住不消失。
  const activeSocketRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  // 消息队列：断线期间缓存待发送消息，重连后统一发出
  const messageQueueRef = useRef<any[]>([]);
  // 入站消息队列：批量收集，防止 React 18 批处理丢弃中间消息
  const incomingMsgQueueRef = useRef<any[]>([]);
  const [incomingMsgVersion, setIncomingMsgVersion] = useState(0);
  const incomingNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 心跳计时器
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // pong 超时计时器
  const pongTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 最近一次收到服务端消息的时间戳，用于识别僵尸连接
  const lastServerMsgAtRef = useRef<number>(Date.now());
  // 命令送达回执跟踪：clientTs(ackId) → 超时计时器。
  // 发出 *-command 后启动计时；收到 command-ack 清除；超时则判定消息丢失（僵尸连接），
  // 主动触发重连并向消费队列注入 command-undelivered，让 UI 把该消息标记为「未送达」。
  const pendingAckRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const ACK_TIMEOUT_MS = 15000;
  const LIVENESS_PING_TIMEOUT_MS = 15000;
  // 始终指向最新的 verifyConnection，供 sendMessage（空依赖 useCallback）在送达超时时调用
  const verifyConnectionRef = useRef<(() => void) | null>(null);
  const { token } = useAuth();

  const scheduleIncomingDrain = useCallback(() => {
    if (incomingNotifyTimerRef.current) return;
    incomingNotifyTimerRef.current = setTimeout(() => {
      incomingNotifyTimerRef.current = null;
      setIncomingMsgVersion(v => v + 1);
    }, 16);
  }, []);

  const startCommandAckTimer = useCallback((message: any) => {
    // 对话命令送达跟踪：用 options.clientTs 作 ackId，启动超时计时。
    // 只在消息已经真实写入 OPEN socket 后启动；排队消息等重连 flush 时再启动，
    // 避免重连窗口内误判为未送达并主动 close，造成"一发命令就 reconnecting"。
    const ackId: unknown = message?.options?.clientTs;
    if (
      typeof message?.type === 'string' && message.type.endsWith('-command') &&
      typeof ackId === 'number'
    ) {
      const prev = pendingAckRef.current.get(ackId);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(() => {
        pendingAckRef.current.delete(ackId);
        verifyConnectionRef.current?.();
        incomingMsgQueueRef.current.push({ type: 'command-undelivered', ackId });
        scheduleIncomingDrain();
      }, ACK_TIMEOUT_MS);
      pendingAckRef.current.set(ackId, timer);
    }
  }, [scheduleIncomingDrain]);

  useEffect(() => {
    unmountedRef.current = false; // token 变化（登录）重新触发 effect 时，需重置此标志，否则 connect() 会因为上一次 cleanup 的 true 值而直接 return
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
      pendingAckRef.current.forEach((t) => clearTimeout(t));
      pendingAckRef.current.clear();
      if (incomingNotifyTimerRef.current) clearTimeout(incomingNotifyTimerRef.current);
      // 关 activeSocketRef 而非 wsRef：CONNECTING 中尚未 open 的 socket 此时 wsRef 仍为旧值/null，
      // 用 activeSocketRef 才能确保把正在握手的 socket 也一并关闭，避免泄漏的半连接。
      if (activeSocketRef.current) { try { activeSocketRef.current.close(); } catch { /* ignore */ } }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    try {
      if (isJwtExpired(token)) {
        notifyInvalidAuthToken();
        setIsConnected(false);
        return;
      }

      const wsUrl = buildWebSocketUrl(token);
      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      activeSocketRef.current = websocket; // 标记为当前最新 socket

      websocket.onopen = () => {
        // 若已被更晚发起的连接取代，则放弃这条旧 socket，避免双连接
        if (activeSocketRef.current !== websocket) { try { websocket.close(); } catch { /* ignore */ } return; }
        setIsConnected(true);
        wsRef.current = websocket;
        reconnectAttemptsRef.current = 0;

        // 连接成功后发送积压消息。只有 send 成功后才从队列移除；
        // 若连接在 flush 中途再次断开，未写出的尾部必须留给下一次重连。
        while (messageQueueRef.current.length > 0) {
          const msg = messageQueueRef.current[0];
          try {
            websocket.send(JSON.stringify(msg));
            startCommandAckTimer(msg);
            messageQueueRef.current.shift();
          } catch {
            break;
          }
        }

        // 用服务端快照校正刷新前持久化的 processing 状态，并立即恢复
        // 其他标签页/会话正在运行的绿色状态点。
        try { websocket.send(JSON.stringify({ type: 'get-active-sessions' })); } catch { /* ignore */ }

        // 启动心跳（间隔 15s）。
        // 关键：只在 idle（>30s 没收到任何服务端消息）时才发 ping。
        // Claude 活跃流式传输期间服务端 event loop 繁忙，pong 可能 >10s 才回来，
        // 激进超时会误判为僵尸连接并强制断开正常连接 → 造成频繁重连。
        // 有实时消息说明连接健康，无需 ping；只有真正 idle 30s+ 才需要探活。
        lastServerMsgAtRef.current = Date.now(); // 重置，避免刚连上就误判
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = setInterval(() => {
          if (websocket.readyState !== WebSocket.OPEN) return;
          const idleMs = Date.now() - lastServerMsgAtRef.current;
          if (idleMs < 30000) return; // 30s 内有消息，连接健康，跳过 ping
          try { websocket.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
          if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
          pongTimeoutRef.current = setTimeout(() => {
            console.warn('[WS] pong timeout – closing zombie connection');
            websocket.close();
          }, 20000); // idle 状态下服务端响应应很快，20s 足够
        }, 15000);
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Model turns started by another browser tab may share the same account
          // and even the same temporary "new chat" state. Targeted frames must be
          // rejected before they enter the shared React message queue.
          if (
            data?.targetClientInstanceId &&
            data.targetClientInstanceId !== clientInstanceIdRef.current
          ) {
            return;
          }
          // Any frame correlated to the submitted turn proves that the command
          // reached the server. This avoids a false "not delivered" state when
          // a busy event loop delays the dedicated command-ack frame.
          if (typeof data?.turnClientTs === 'number') {
            const timer = pendingAckRef.current.get(data.turnClientTs);
            if (timer) {
              clearTimeout(timer);
              pendingAckRef.current.delete(data.turnClientTs);
            }
          }
          // 收到 pong：清除僵尸连接超时计时器
          lastServerMsgAtRef.current = Date.now(); // 每收到任意消息都更新，pong 也算
          if (data?.type === 'pong') {
            if (pongTimeoutRef.current) { clearTimeout(pongTimeoutRef.current); pongTimeoutRef.current = null; }
            return;
          }
          // 服务端应用层保活帧：仅用于刷新代理 idle 计时器与 lastServerMsgAt，
          // 不进入消息消费队列（避免无意义的 re-render 与下游处理）。
          if (data?.type === 'heartbeat') {
            return;
          }
          if (data?.type === 'daily-usage-updated') {
            window.dispatchEvent(new Event('helix:daily-input-changed'));
            return;
          }
          if (data?.type === 'active-sessions') {
            window.dispatchEvent(new CustomEvent('helix:active-sessions-snapshot', {
              detail: data.sessions || {},
            }));
          }
          // 命令送达回执：清除对应的超时计时器（消息确认抵达后端）。
          // 不在此 return——继续下传到消费队列，让聊天层把该消息标记为「已送达」。
          if (data?.type === 'command-ack' && typeof data.ackId === 'number') {
            const timer = pendingAckRef.current.get(data.ackId);
            if (timer) { clearTimeout(timer); pendingAckRef.current.delete(data.ackId); }
          }
          incomingMsgQueueRef.current.push(data);
          // Chat consumes the lossless queue. Only project/status control frames
          // need the legacy latestMessage channel; streaming frames are batched
          // to one React update per animation-sized interval.
          if (['projects_updated', 'loading_progress', 'session-status'].includes(data?.type)) {
            setLatestMessage(data);
          }
          scheduleIncomingDrain();
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        // 旧 socket 的延迟 onclose：当前已有更新的 socket 在管理连接状态，
        // 直接忽略——绝不能触碰共享的 isConnected/wsRef/心跳计时器，否则会误杀健康连接。
        if (activeSocketRef.current !== websocket) return;
        setIsConnected(false);
        wsRef.current = null;
        if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
        if (pongTimeoutRef.current) { clearTimeout(pongTimeoutRef.current); pongTimeoutRef.current = null; }
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);

        // 快速重连：100ms → 500ms → 1s → 2s，最长 3s
        // 降低重连延迟，缩短"connectedClients 为空"的时间窗口，减少后端输出丢失
        const attempts = reconnectAttemptsRef.current;
        const delay = attempts === 0 ? 100 : Math.min(500 * Math.pow(2, attempts - 1), 3000);
        reconnectAttemptsRef.current = attempts + 1;

        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return;
          connect();
        }, delay);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
        if (websocket.readyState === WebSocket.CONNECTING || websocket.readyState === WebSocket.OPEN) {
          websocket.close();
        }
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
      setIsConnected(false);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      const attempts = reconnectAttemptsRef.current;
      const delay = attempts === 0 ? 100 : Math.min(500 * Math.pow(2, attempts - 1), 3000);
      reconnectAttemptsRef.current = attempts + 1;
      reconnectTimeoutRef.current = setTimeout(() => {
        if (unmountedRef.current) return;
        connect();
      }, delay);
    }
  }, [scheduleIncomingDrain, startCommandAckTimer, token]);

  // 主动探活：标签页重新可见 / 网络恢复时，立即核验 socket 是否还活着。
  // 解决"笔记本休眠 / 断网瞬断"导致 socket 静默死亡、却没人察觉 → 必须手动刷新网页的顽疾。
  // - socket 已 CLOSED/CLOSING：立刻重连（重置退避计数，跳过等待）。
  // - socket 仍 OPEN：发一个 ping，5s 内没 pong 就主动 close，触发 onclose → 快速重连。
  const verifyConnection = useCallback(() => {
    if (unmountedRef.current) return;
    const sock = activeSocketRef.current;
    if (!sock || sock.readyState === WebSocket.CLOSED || sock.readyState === WebSocket.CLOSING) {
      if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
      reconnectAttemptsRef.current = 0; // 用户主动回到页面，立即重连而非继续退避
      connect();
      return;
    }
    if (sock.readyState === WebSocket.OPEN) {
      try { sock.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
      if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
      // 探活场景下服务端应秒回；5s 没 pong 视为僵尸连接，主动断开触发重连
      pongTimeoutRef.current = setTimeout(() => {
        console.warn('[WS] liveness ping timeout – closing stale socket');
        try { sock.close(); } catch { /* ignore */ }
      }, LIVENESS_PING_TIMEOUT_MS);
    }
  }, [connect]);
  verifyConnectionRef.current = verifyConnection;

  // 注册标签页可见性 / 网络恢复监听，触发主动探活
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') verifyConnection(); };
    const onOnline = () => verifyConnection();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisible);
    };
  }, [verifyConnection]);

  const sendMessage = useCallback((message: any) => {
    const scopedMessage = {
      ...message,
      clientInstanceId: clientInstanceIdRef.current,
      options: message?.options
        ? { ...message.options, clientInstanceId: clientInstanceIdRef.current }
        : message?.options,
    };
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(scopedMessage));
        startCommandAckTimer(scopedMessage);
      } catch (e) {
        // send 抛出异常（socket 已在关闭中）→ 入队等重连
        messageQueueRef.current.push(scopedMessage);
        if (messageQueueRef.current.length > 30) messageQueueRef.current.shift();
      }
    } else {
      // 连接未就绪时入队，重连后自动重发（最多缓存30条）
      messageQueueRef.current.push(scopedMessage);
      if (messageQueueRef.current.length > 30) {
        messageQueueRef.current.shift();
      }
    }
  }, [startCommandAckTimer]);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected,
    incomingMsgQueueRef,
    incomingMsgVersion,
  }), [sendMessage, latestMessage, isConnected, incomingMsgVersion]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
