// 删除文件夹的确认弹窗：明确告知"只清前端归类，不动本地会话文件"
import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../ui/button';

type Props = {
  isOpen: boolean;
  folderName: string;
  fetchCounts: () => Promise<{ sessions: number; folders: number }>;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function SidebarFolderDeleteConfirm({
  isOpen,
  folderName,
  fetchCounts,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useTranslation('sidebar');
  const [counts, setCounts] = useState<{ sessions: number; folders: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setCounts(null);
      return;
    }
    let cancelled = false;
    fetchCounts().then((c) => {
      if (!cancelled) setCounts(c);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, fetchCounts]);

  if (!isOpen) return null;

  const sessionCount = counts?.sessions ?? 0;
  const folderCount = counts?.folders ?? 0;

  const renderContents = () => {
    if (counts === null) {
      return <p className="text-muted-foreground text-xs">{t('folders.delete.loadingCounts')}</p>;
    }
    if (sessionCount === 0 && folderCount === 0) {
      return <p>{t('folders.delete.empty')}</p>;
    }
    let key: string;
    if (sessionCount > 0 && folderCount > 0) key = 'folders.delete.containsBoth';
    else if (folderCount > 0) key = 'folders.delete.containsFolders';
    else key = 'folders.delete.containsSessions';
    return <p>{t(key, { folders: folderCount, sessions: sessionCount })}</p>;
  };

  return (
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-background/80 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm bg-card border border-border rounded-lg shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-3">
          <div className="w-9 h-9 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{t('folders.delete.title')}</h3>
            <p className="text-xs text-muted-foreground mt-1 break-all">「{folderName}」</p>
          </div>
          <button
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
            onClick={onCancel}
            aria-label={t('folders.delete.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="text-sm text-foreground space-y-2 mb-4">
          {renderContents()}
          {counts !== null && (sessionCount > 0 || folderCount > 0) && (
            <p className="text-xs text-muted-foreground bg-muted/40 rounded px-2 py-1.5 leading-relaxed">
              {t('folders.delete.explanation')}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
            {t('folders.delete.cancel')}
          </Button>
          <Button
            size="sm"
            className="bg-red-600 hover:bg-red-700 text-white"
            disabled={submitting || counts === null}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onConfirm();
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? t('folders.delete.deleting') : t('folders.delete.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
