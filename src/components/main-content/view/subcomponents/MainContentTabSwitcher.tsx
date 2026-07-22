import { MessageSquare, Terminal, SquareTerminal, Folder, GitBranch, ClipboardCheck, type LucideIcon } from 'lucide-react';
import Tooltip from '../../../Tooltip';
import type { AppTab } from '../../../../types/app';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

type MainContentTabSwitcherProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
};

type TabDefinition = {
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

const BASE_TABS: TabDefinition[] = [
  { id: 'chat', labelKey: 'tabs.chat', icon: MessageSquare },
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'terminal', labelKey: 'tabs.terminal', icon: SquareTerminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
  { id: 'git', labelKey: 'tabs.git', icon: GitBranch },
];

const TASKS_TAB: TabDefinition = {
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

export default function MainContentTabSwitcher({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();

  const tabs = shouldShowTasksTab ? [...BASE_TABS, TASKS_TAB] : BASE_TABS;

  /* 外层 wrapper 切角 10px，内层 button 切角 8.5px
     直边：1.5px padding 露出边框色；斜角：10px-8.5px=1.5px 缺口露出边框色
     → 全部 8 条边都可见 */
  const OCT_OUT = 'polygon(10px 0%,calc(100% - 10px) 0%,100% 10px,100% calc(100% - 10px),calc(100% - 10px) 100%,10px 100%,0% calc(100% - 10px),0% 10px)';
  const OCT_IN  = 'polygon(8.5px 0%,calc(100% - 8.5px) 0%,100% 8.5px,100% calc(100% - 8.5px),calc(100% - 8.5px) 100%,8.5px 100%,0% calc(100% - 8.5px),0% 8.5px)';

  return (
    <div className="inline-flex items-center bg-muted/60 rounded-lg p-[3px] gap-[2px] tech-main-tabs">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.id === activeTab;

        return (
          <Tooltip key={tab.id} content={t(tab.labelKey)} position="bottom">
            {/* 外层 div = 边框色 + 10px切角 + 1.5px padding
                内层 button = 填充色 + 8.5px切角
                → 直边和斜角全部 8 条边可见 */}
            <div
              className="tech-tab-border"
              style={{
                display: 'inline-flex',
                padding: '1.5px',
                clipPath: OCT_OUT,
                background: isActive
                  ? 'rgba(0, 240, 255, 1)'          /* 激活边框：最亮青蓝 */
                  : 'rgba(0, 200, 250, 0.92)',       /* 非激活边框：中亮青蓝（+50%） */
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(0, 225, 255, 0.98)';
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(0, 200, 250, 0.92)';
              }}
            >
              <button
                onClick={() => setActiveTab(tab.id)}
                className={`tech-tab-btn relative flex items-center gap-1.5 px-2.5 py-[5px] text-sm font-medium transition-all duration-150 ${
                  isActive ? 'tech-tab-active' : ''
                }`}
                style={{ clipPath: OCT_IN }}
              >
                <Icon className="w-3.5 h-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
                <span className="hidden lg:inline">{t(tab.labelKey)}</span>
              </button>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}
