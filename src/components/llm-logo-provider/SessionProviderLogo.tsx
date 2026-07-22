import type { SessionProvider } from '../../types/app';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import GeminiLogo from '../GeminiLogo';

type SessionProviderLogoProps = {
  provider?: SessionProvider | string | null;
  className?: string;
};

function CustomProviderLogo({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="18" cy="18" r="17" stroke="currentColor" strokeWidth="2" opacity="0.3" />
      <path d="M10 18h16M18 10v16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="18" cy="18" r="4" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'gemini') {
    return <GeminiLogo className={className} />;
  }

  if (provider !== 'claude') {
    return <CustomProviderLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
