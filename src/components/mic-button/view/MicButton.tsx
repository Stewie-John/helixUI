import { useMicButtonController } from '../hooks/useMicButtonController';
import MicButtonView from './MicButtonView';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SPEECH_RECOGNITION_LANGUAGES } from '../constants/constants';

type MicButtonProps = {
  onTranscript?: (transcript: string, isFinal?: boolean) => void;
  className?: string;
  mode?: string;
};

export default function MicButton({
  onTranscript,
  className = '',
  mode: _mode,
}: MicButtonProps) {
  const { t } = useTranslation('chat');
  const [language, setLanguage] = useState(() => localStorage.getItem('speechRecognitionLanguage') || 'auto');
  const { state, error, isSupported, handleButtonClick } = useMicButtonController({
    onTranscript,
    language,
  });

  // Keep `mode` in the public props for backwards compatibility.
  void _mode;

  return (
    <MicButtonView
      state={state}
      error={error}
      isSupported={isSupported}
      className={className}
      onButtonClick={handleButtonClick}
      language={language}
      languages={SPEECH_RECOGNITION_LANGUAGES}
      onLanguageChange={(nextLanguage) => {
        setLanguage(nextLanguage);
        localStorage.setItem('speechRecognitionLanguage', nextLanguage);
      }}
      labels={{
        idle: t('input.voice.start', { defaultValue: 'Start voice input' }),
        recording: t('input.voice.stop', { defaultValue: 'Stop recording and transcribe' }),
        transcribing: t('input.voice.transcribing', { defaultValue: 'Transcribing...' }),
        language: t('input.voice.language', { defaultValue: 'Recognition language' }),
      }}
    />
  );
}
