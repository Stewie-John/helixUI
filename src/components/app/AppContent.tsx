import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import MobileNav from '../MobileNav';
import DNABackground from '../tech/DNABackground';
import HUDOverlay from '../tech/HUDOverlay';
import ErrorBoundary from '../ErrorBoundary';
import { useTheme } from '../../contexts/ThemeContext';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useVisualPerformanceMode } from '../../hooks/useVisualPerformanceMode';

export default function AppContent() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { theme } = useTheme();

  // HUD 面板为 position:fixed 叠层，不再挤压整个内容区
  // 仅消息区域通过 ClaudeStatus overlay 实现局部避让
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, latestMessage, isConnected } = useWebSocket();
  const wasConnectedRef = useRef(false);
  const { reduceAnimations } = useVisualPerformanceMode();
  const [hudReservePx, setHudReservePx] = useState(262);
  const showTechDecor = theme === 'tech' && !isMobile && !reduceAnimations;
  const showMobileTechBackdrop = theme === 'tech' && isMobile;

  const {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    newSessionNonce,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    isInputFocused,
    externalMessageUpdate,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    sidebarSharedProps,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  useEffect(() => {
    window.refreshProjects = fetchProjects;

    return () => {
      if (window.refreshProjects === fetchProjects) {
        delete window.refreshProjects;
      }
    };
  }, [fetchProjects]);

  useEffect(() => {
    window.openSettings = openSettings;

    return () => {
      if (window.openSettings === openSettings) {
        delete window.openSettings;
      }
    };
  }, [openSettings]);

  // Permission recovery: query pending permissions on WebSocket reconnect or session change
  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;

    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);


  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (theme === 'tech' && reduceAnimations) {
      root.classList.add('tech-performance-low');
    } else {
      root.classList.remove('tech-performance-low');
    }
    if (showMobileTechBackdrop) {
      root.classList.add('tech-mobile-video');
    } else {
      root.classList.remove('tech-mobile-video');
    }
    return () => {
      root.classList.remove('tech-performance-low');
      root.classList.remove('tech-mobile-video');
    };
  }, [theme, reduceAnimations, showMobileTechBackdrop]);

  useEffect(() => {
    if (!showTechDecor) {
      setHudReservePx(0);
      return;
    }

    const updateHudReserve = (detail?: { left?: number } | null) => {
      if (!detail?.left || typeof window === 'undefined') {
        setHudReservePx(232);
        return;
      }

      const reserve = Math.ceil(window.innerWidth - detail.left + 8);
      setHudReservePx(Math.max(180, Math.min(420, reserve)));
    };

    const handleHudPanelPos = (event: Event) => {
      updateHudReserve((event as CustomEvent<{ left?: number } | null>).detail);
    };

    window.addEventListener('hud-panel-pos', handleHudPanelPos);
    return () => window.removeEventListener('hud-panel-pos', handleHudPanelPos);
  }, [showTechDecor]);

  const showInputSeparator = activeTab !== 'files';

  return (
    <div
      className="fixed inset-0 flex bg-background"
      style={showTechDecor ? { '--tech-hud-reserve': `${hudReservePx}px` } as CSSProperties : undefined}
    >
      {/* DNA 双螺旋动态背景 + HUD 装饰叠层（仅桌面高性能科技主题下显示） */}
      {showTechDecor && <DNABackground />}
      {showMobileTechBackdrop && <DNABackground forceVideo />}
      {showTechDecor && (
        <HUDOverlay
          sessionName={selectedSession?.summary || selectedSession?.name || undefined}
          sessionId={selectedSession?.id}
          projectName={selectedProject?.name}
          provider={selectedSession?.__provider}
        />
      )}
      {showTechDecor && (
        <div className={`tech-layout-line-overlay ${isInputFocused ? 'tech-input-focused' : ''}`} aria-hidden="true">
          {showInputSeparator && <span className="tech-input-separator-line" />}
        </div>
      )}
      {!isMobile ? (
        <div className={`h-full flex-shrink-0 relative z-[1] ${theme !== 'tech' ? 'border-r border-border/50' : ''}`}>
          <ErrorBoundary showDetails>
            <Sidebar {...sidebarSharedProps} />
          </ErrorBoundary>
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'opacity-100 visible' : 'opacity-0 invisible'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`tech-sidebar-drawer relative w-[85vw] max-w-sm sm:w-80 h-full bg-card border-r border-border/40 transform transition-transform duration-150 ease-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarSharedProps} />
          </div>
        </div>
      )}

      <div
        ref={contentAreaRef}
        className={`flex-1 flex flex-col min-w-0 ${isMobile ? 'pb-mobile-nav' : ''}`}
        style={showTechDecor ? { paddingRight: `${hudReservePx}px` } : undefined}
      >
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          newSessionNonce={newSessionNonce}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={markSessionAsInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          processingSessions={processingSessions}
          activeSessions={activeSessions}
          onReplaceTemporarySession={replaceTemporarySession}
          onNavigateToSession={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
          onShowSettings={() => setShowSettings(true)}
          externalMessageUpdate={externalMessageUpdate}
        />
      </div>

      {isMobile && (
        <MobileNav
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isInputFocused={isInputFocused}
        />
      )}

    </div>
  );
}
