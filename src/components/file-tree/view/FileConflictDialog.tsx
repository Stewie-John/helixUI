import { useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

export type ConflictPolicy = 'replace' | 'keepBoth' | 'skip';
export type ConflictResolution = ConflictPolicy | 'cancel';

interface FileConflictDialogProps {
  // 与目标目录中已存在文件重名的相对路径列表
  conflicts: string[];
  onResolve: (resolution: ConflictResolution) => void;
}

// Mac Finder 风格的重名冲突对话框：覆盖 / 两者都保留 / 跳过 / 取消。
// 当一次拖入/粘贴的文件与目标目录已有文件重名时弹出，选择应用于本批次的全部冲突项。
function FileConflictDialog({ conflicts, onResolve }: FileConflictDialogProps) {
  const { t } = useTranslation('codeEditor');
  const count = conflicts.length;
  const single = count === 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolve('cancel');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onResolve]);

  return (
    <div
      className="absolute inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => onResolve('cancel')}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-background shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 pt-5 pb-4 flex gap-3">
          <div className="flex-shrink-0 mt-0.5">
            <AlertTriangle className="w-7 h-7 text-amber-500" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              {single
                ? t('fileConflict.titleSingle')
                : t('fileConflict.titleMultiple', { total: count })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
              {single ? (
                <Trans
                  t={t}
                  i18nKey="fileConflict.descriptionSingle"
                  values={{ name: conflicts[0] }}
                  components={{ b: <span className="font-medium text-foreground break-all" /> }}
                />
              ) : (
                <>{t('fileConflict.descriptionMultiple')}</>
              )}
            </p>
            {!single && (
              <ul className="mt-2 max-h-28 overflow-auto rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground space-y-0.5">
                {conflicts.map((name) => (
                  <li key={name} className="break-all">{name}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="px-5 pb-5 pt-1 flex flex-col gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => onResolve('keepBoth')}
            className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
          >
            {t('fileConflict.keepBoth')}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onResolve('skip')}
              className="flex-1 h-9 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted transition-colors"
            >
              {t('fileConflict.skip')}
            </button>
            <button
              type="button"
              onClick={() => onResolve('replace')}
              className="flex-1 h-9 rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 text-sm font-medium hover:bg-red-500/10 transition-colors"
            >
              {t('fileConflict.replace')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => onResolve('cancel')}
            className="w-full h-8 mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('fileConflict.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FileConflictDialog;
