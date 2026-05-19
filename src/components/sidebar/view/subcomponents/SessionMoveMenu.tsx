// "移动到..." 弹出菜单：列出当前 project 下所有文件夹（缩进展示层级）+ 根目录入口
import { useEffect, useRef } from 'react';
import { Folder, FolderRoot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FolderNode } from '../../hooks/useProjectFolders';

type Props = {
  flatFolders: FolderNode[];
  currentFolderId: number | null;
  onMove: (folderId: number | null) => void;
  onClose: () => void;
  anchor: { top: number; left: number };
};

export default function SessionMoveMenu({
  flatFolders,
  currentFolderId,
  onMove,
  onClose,
  anchor,
}: Props) {
  const { t } = useTranslation('sidebar');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[10000] min-w-[180px] max-h-[280px] overflow-y-auto bg-popover border border-border rounded-md shadow-lg py-1"
      style={{ top: anchor.top, left: anchor.left }}
    >
      <div className="px-2 py-1 text-xs text-muted-foreground border-b border-border mb-1">
        {t('folders.moveMenu.title')}
      </div>
      <button
        className={`w-full text-left flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent ${
          currentFolderId == null ? 'text-blue-600 dark:text-blue-400' : 'text-foreground'
        }`}
        onClick={() => {
          onMove(null);
          onClose();
        }}
      >
        <FolderRoot className="w-3 h-3" />
        {t('folders.moveMenu.root')}
      </button>
      {flatFolders.length > 0 && (
        <div className="border-t border-border my-1" />
      )}
      {flatFolders.map((f) => (
        <button
          key={f.id}
          className={`w-full text-left flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent ${
            currentFolderId === f.id ? 'text-blue-600 dark:text-blue-400' : 'text-foreground'
          }`}
          style={{ paddingLeft: `${8 + f.depth * 12}px` }}
          onClick={() => {
            onMove(f.id);
            onClose();
          }}
        >
          <Folder className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{f.name}</span>
        </button>
      ))}
    </div>
  );
}
