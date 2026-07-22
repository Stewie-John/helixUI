import type { CustomProvider, SessionProvider } from '../../../types/app';

export function getProviderLabel(provider?: SessionProvider | string | null): string {
  if (!provider) return 'AI';
  if (provider === 'claude') return 'Claude';
  if (provider === 'cursor') return 'Cursor';
  if (provider === 'codex') return 'Codex';
  if (provider === 'gemini') return 'Gemini';

  if (typeof window !== 'undefined') {
    try {
      const customProviders = JSON.parse(
        window.localStorage.getItem('custom-providers') || '[]',
      ) as CustomProvider[];
      const customProvider = customProviders.find((item) => item.id === provider);
      if (customProvider?.name?.trim()) {
        return customProvider.name.trim();
      }
    } catch {
      // Fall through to the provider id.
    }
  }

  return String(provider);
}
