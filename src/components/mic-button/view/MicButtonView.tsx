import { Brain, Languages, Loader2, Mic } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { BUTTON_BACKGROUND_BY_STATE, MIC_BUTTON_STATES } from '../constants/constants';
import type { MicButtonState } from '../types/types';

type MicButtonViewProps = {
  state: MicButtonState;
  error: string | null;
  isSupported: boolean;
  className: string;
  onButtonClick: (event?: MouseEvent<HTMLButtonElement>) => void;
  language: string;
  languages: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  onLanguageChange: (language: string) => void;
  labels: { idle: string; recording: string; transcribing: string; language: string };
};

const getButtonIcon = (state: MicButtonState, isSupported: boolean): ReactElement => {
  if (!isSupported) {
    return <Mic className="w-5 h-5" />;
  }

  if (state === MIC_BUTTON_STATES.TRANSCRIBING) {
    return <Loader2 className="w-5 h-5 animate-spin" />;
  }

  if (state === MIC_BUTTON_STATES.PROCESSING) {
    return <Brain className="w-5 h-5 animate-pulse" />;
  }

  if (state === MIC_BUTTON_STATES.RECORDING) {
    return <Mic className="w-5 h-5 text-white" />;
  }

  return <Mic className="w-5 h-5" />;
};

export default function MicButtonView({
  state,
  error,
  isSupported,
  className,
  onButtonClick,
  language,
  languages,
  onLanguageChange,
  labels,
}: MicButtonViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [errorAnchor, setErrorAnchor] = useState<{ top: number; right: number } | null>(null);
  const isDisabled = state === MIC_BUTTON_STATES.TRANSCRIBING || state === MIC_BUTTON_STATES.PROCESSING;
  const icon = getButtonIcon(state, isSupported);
  const buttonLabel = !isSupported
    ? error || labels.idle
    : state === MIC_BUTTON_STATES.RECORDING
      ? labels.recording
      : state === MIC_BUTTON_STATES.IDLE
        ? labels.idle
        : labels.transcribing;

  useEffect(() => {
    if (!error || !isSupported) {
      setErrorAnchor(null);
      return undefined;
    }
    const updateAnchor = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setErrorAnchor({
        top: rect.top - 8,
        right: Math.max(12, window.innerWidth - rect.right),
      });
    };
    updateAnchor();
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    return () => {
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
    };
  }, [error, isSupported]);

  return (
    <>
    <div ref={rootRef} className="relative flex items-stretch h-10 sm:h-10 rounded-lg overflow-visible border border-border/60 bg-card/90 shadow-sm">
      <button
        type="button"
        style={{ backgroundColor: BUTTON_BACKGROUND_BY_STATE[state] }}
        className={`
          flex items-center justify-center
          w-10 h-10 rounded-l-lg
          text-white transition-all duration-200
          focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500
          dark:ring-offset-gray-800
          touch-action-manipulation
          ${isDisabled ? 'cursor-not-allowed opacity-75' : 'cursor-pointer'}
          ${!isSupported ? 'opacity-75' : ''}
          ${state === MIC_BUTTON_STATES.RECORDING ? 'animate-pulse' : ''}
          hover:opacity-90
          ${className}
        `}
        onClick={onButtonClick}
        disabled={isDisabled}
        title={buttonLabel}
        aria-label={buttonLabel}
      >
        {icon}
      </button>

      <div className="relative w-7 h-10 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-r-lg">
        <Languages className="w-3.5 h-3.5" aria-hidden="true" />
        <select
          value={language}
          onChange={(event) => onLanguageChange(event.target.value)}
          disabled={state !== MIC_BUTTON_STATES.IDLE}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
          title={labels.language}
          aria-label={labels.language}
        >
          {languages.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      {state === MIC_BUTTON_STATES.RECORDING && (
        <div className="absolute -inset-1 rounded-lg border-2 border-red-500 animate-ping pointer-events-none" />
      )}

      {state === MIC_BUTTON_STATES.PROCESSING && (
        <div className="absolute -inset-1 rounded-full border-2 border-purple-500 animate-ping pointer-events-none" />
      )}
    </div>
    {error && isSupported && errorAnchor && createPortal(
      <div
        role="alert"
        className="fixed w-max max-w-[min(32rem,calc(100vw-24px))]
                   bg-red-600 text-white text-xs leading-5 px-3 py-2 rounded-md
                   whitespace-normal break-words shadow-lg animate-fade-in"
        style={{
          top: errorAnchor.top,
          right: errorAnchor.right,
          transform: 'translateY(-100%)',
          zIndex: 10050,
          overflowWrap: 'anywhere',
        }}
      >
        {error}
      </div>,
      document.body,
    )}
    </>
  );
}
