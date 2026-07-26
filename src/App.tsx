import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { TaskMasterProvider } from './contexts/TaskMasterContext';
import { TasksSettingsProvider } from './contexts/TasksSettingsContext';
import { TodoProgressProvider } from './contexts/TodoProgressContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppContent from './components/app/AppContent';
import i18n from './i18n/config.js';
import { scheduleStaleBundleRecovery } from './utils/staleBundleRecovery';

/**
 * 顶层错误边界：防止任何子组件崩溃导致整页黑屏。
 * 显示可恢复的回退 UI，用户可刷新或清除缓存重试。
 */
class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null; errorInfo: ErrorInfo | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[AppErrorBoundary] Uncaught error:', error, errorInfo);
    if (scheduleStaleBundleRecovery(error)) return;
    this.setState({ errorInfo });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleClearAndReload = () => {
    try {
      // 清除可能导致崩溃的缓存数据
      // userLanguage 一起清掉的话，用户每次从崩溃里恢复都会被打回英文。
      const keysToKeep = ['auth-token', 'theme', 'userLanguage'];
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && !keysToKeep.includes(key)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    } catch {
      // 忽略
    }
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0f172a',
            color: '#e2e8f0',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            zIndex: 99999,
          }}
        >
          <div
            style={{
              maxWidth: 420,
              padding: 32,
              borderRadius: 12,
              background: 'rgba(30, 41, 59, 0.9)',
              border: '1px solid rgba(100, 116, 139, 0.3)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 16 }}>⚠</div>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
              {i18n.t('common:errorBoundary.title')}
            </h2>
            <p style={{ fontSize: 14, color: '#94a3b8', marginBottom: 20, lineHeight: 1.5 }}>
              {i18n.t('common:errorBoundary.description')}
            </p>

            {this.state.error && (
              <details
                style={{
                  marginBottom: 20,
                  textAlign: 'left',
                  fontSize: 12,
                  color: '#ef4444',
                  background: 'rgba(239, 68, 68, 0.08)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                }}
              >
                <summary style={{ cursor: 'pointer', marginBottom: 4, color: '#f87171' }}>
                  {i18n.t('common:errorBoundary.details')}
                </summary>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: 150,
                    overflow: 'auto',
                    margin: 0,
                  }}
                >
                  {this.state.error.toString()}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={this.handleReload}
                style={{
                  padding: '8px 20px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#3b82f6',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {i18n.t('common:errorBoundary.reload')}
              </button>
              <button
                onClick={this.handleClearAndReload}
                style={{
                  padding: '8px 20px',
                  borderRadius: 6,
                  border: '1px solid rgba(100, 116, 139, 0.4)',
                  background: 'transparent',
                  color: '#94a3b8',
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {i18n.t('common:errorBoundary.clearAndReload')}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <AuthProvider>
            <WebSocketProvider>
              <TodoProgressProvider>
              <TasksSettingsProvider>
                <TaskMasterProvider>
                  <ProtectedRoute>
                    <Router basename={window.__ROUTER_BASENAME__ || ''}>
                      <Routes>
                        <Route path="/" element={<AppContent />} />
                        <Route path="/session/:sessionId" element={<AppContent />} />
                      </Routes>
                    </Router>
                  </ProtectedRoute>
                </TaskMasterProvider>
              </TasksSettingsProvider>
              </TodoProgressProvider>
            </WebSocketProvider>
          </AuthProvider>
        </ThemeProvider>
      </I18nextProvider>
    </AppErrorBoundary>
  );
}
