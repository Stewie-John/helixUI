import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { CustomProvider } from '../../../../../../types/app';

const STORAGE_KEY = 'custom-providers';

function loadProviders(): CustomProvider[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveProviders(providers: CustomProvider[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
  // 触发跨 tab 的 storage 事件，通知 ProviderSelectionEmptyState 刷新
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
}

function generateId(name: string) {
  return `custom_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
}

const EMPTY_FORM = { name: '', baseURL: '', apiKey: '', model: '', description: '' };

export default function CustomProvidersSection() {
  const { t } = useTranslation('settings');
  const [providers, setProviders] = useState<CustomProvider[]>(loadProviders);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showApiKey, setShowApiKey] = useState(false);
  const [errors, setErrors] = useState<Partial<typeof EMPTY_FORM>>({});

  const validate = () => {
    const e: Partial<typeof EMPTY_FORM> = {};
    if (!form.name.trim()) e.name = 'Required';
    if (!form.baseURL.trim()) e.baseURL = 'Required';
    if (!form.model.trim()) e.model = 'Required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = () => {
    if (!validate()) return;
    let updated: CustomProvider[];
    if (editingId) {
      updated = providers.map((p) =>
        p.id === editingId ? { ...p, ...form } : p
      );
    } else {
      const newProvider: CustomProvider = {
        id: generateId(form.name),
        name: form.name.trim(),
        baseURL: form.baseURL.trim(),
        apiKey: form.apiKey.trim(),
        model: form.model.trim(),
        description: form.description.trim() || undefined,
      };
      updated = [...providers, newProvider];
    }
    saveProviders(updated);
    setProviders(updated);
    resetForm();
  };

  const handleEdit = (p: CustomProvider) => {
    setEditingId(p.id);
    setForm({ name: p.name, baseURL: p.baseURL, apiKey: p.apiKey, model: p.model, description: p.description || '' });
    setErrors({});
    setShowForm(true);
    setShowApiKey(false);
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this custom provider?')) return;
    const updated = providers.filter((p) => p.id !== id);
    saveProviders(updated);
    setProviders(updated);
  };

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setShowApiKey(false);
  };

  const field = (key: keyof typeof EMPTY_FORM) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      if (errors[key]) setErrors((er) => ({ ...er, [key]: undefined }));
    },
  });

  const inputClass = (err?: string) =>
    `w-full px-3 py-2 text-sm border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 ${err ? 'border-red-500' : 'border-border'}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('customProviders.title')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('customProviders.description')}
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); setErrors({}); }}
            className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            {t('customProviders.add')}
          </button>
        )}
      </div>

      {/* Provider list */}
      {providers.length > 0 && (
        <div className="space-y-2 mb-4">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-3 py-2.5 border border-border rounded-lg bg-muted/30">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                <p className="text-xs text-muted-foreground truncate">{p.baseURL} · {p.model}</p>
              </div>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <button
                  onClick={() => handleEdit(p)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('customProviders.edit')}
                </button>
                <button
                  onClick={() => handleDelete(p.id)}
                  className="text-xs text-red-500 hover:text-red-600 transition-colors"
                >
                  {t('customProviders.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {providers.length === 0 && !showForm && (
        <div className="text-xs text-muted-foreground py-3 text-center border border-dashed border-border rounded-lg mb-4">
          {t('customProviders.empty')}
        </div>
      )}

      {/* Add / Edit form */}
      {showForm && (
        <div className="border border-border rounded-xl p-4 space-y-3 bg-muted/10 mb-4">
          <p className="text-sm font-semibold text-foreground">{editingId ? t('customProviders.formTitleEdit') : t('customProviders.formTitleNew')}</p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('customProviders.nameLabel')}</label>
              <input {...field('name')} placeholder="DeepSeek" className={inputClass(errors.name)} />
              {errors.name && <p className="text-xs text-red-500 mt-0.5">{errors.name}</p>}
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('customProviders.modelLabel')}</label>
              <input {...field('model')} placeholder="deepseek-chat" className={inputClass(errors.model)} />
              {errors.model && <p className="text-xs text-red-500 mt-0.5">{errors.model}</p>}
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('customProviders.baseUrlLabel')} <span className="text-muted-foreground/60">{t('customProviders.baseUrlHint')}</span></label>
            <input {...field('baseURL')} placeholder="http://localhost:4000/v1" className={inputClass(errors.baseURL)} />
            {errors.baseURL && <p className="text-xs text-red-500 mt-0.5">{errors.baseURL}</p>}
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
            <div className="relative">
              <input
                {...field('apiKey')}
                type={showApiKey ? 'text' : 'password'}
                placeholder="sk-..."
                className={`${inputClass()} pr-16`}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
              >
                {showApiKey ? t('customProviders.hideApiKey') : t('customProviders.showApiKey')}
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('customProviders.descriptionLabel')}</label>
            <input {...field('description')} placeholder="via LiteLLM proxy" className={inputClass()} />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
            >
              {t('customProviders.save')}
            </button>
            <button
              onClick={resetForm}
              className="px-4 py-1.5 text-xs font-medium border border-border rounded-lg text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('customProviders.cancel')}
            </button>
          </div>

          <div className="border-t border-border/50 pt-3">
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
              <Trans
                t={t}
                i18nKey="customProviders.usage"
                components={{ b: <strong />, c: <code /> }}
              />
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
