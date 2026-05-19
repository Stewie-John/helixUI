// 新建文件夹的内联输入框（root 层 / 任一 folder 内复用）
import { useState } from 'react';
import { Check, X, FolderPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Props = {
  onSubmit: (name: string) => Promise<void> | void;
  onCancel: () => void;
  placeholder?: string;
};

export default function FolderCreateInput({ onSubmit, onCancel, placeholder }: Props) {
  const { t } = useTranslation('sidebar');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-1 px-1.5 py-1 rounded-md bg-blue-50/50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
      <FolderPlus className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          else if (e.key === 'Escape') onCancel();
        }}
        autoFocus
        disabled={submitting}
        placeholder={placeholder ?? t('folders.create.namePlaceholder')}
        className="flex-1 min-w-0 px-1.5 py-0.5 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <button
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600 dark:text-green-400 disabled:opacity-50"
        onClick={submit}
        disabled={submitting}
        title={t('folders.create.confirm')}
      >
        <Check className="w-3 h-3" />
      </button>
      <button
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground"
        onClick={onCancel}
        disabled={submitting}
        title={t('folders.create.cancel')}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
