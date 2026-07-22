import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { transcribeWithWhisper } from '../data/whisper';
import {
  DEFAULT_WHISPER_MODE,
  ENHANCEMENT_WHISPER_MODES,
  MIC_BUTTON_STATES,
  MIC_ERROR_BY_NAME,
  MIC_NOT_AVAILABLE_ERROR,
  MIC_NOT_SUPPORTED_ERROR,
  MIC_SECURE_CONTEXT_ERROR,
  MIC_TAP_DEBOUNCE_MS,
  PROCESSING_STATE_DELAY_MS,
} from '../constants/constants';
import type { MicButtonState } from '../types/types';

type UseMicButtonControllerArgs = {
  onTranscript?: (transcript: string, isFinal?: boolean) => void;
  language?: string;
};

type UseMicButtonControllerResult = {
  state: MicButtonState;
  error: string | null;
  isSupported: boolean;
  handleButtonClick: (event?: MouseEvent<HTMLButtonElement>) => void;
};

const getRecordingErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.includes('HTTPS')) {
    return error.message;
  }

  if (error instanceof DOMException) {
    return MIC_ERROR_BY_NAME[error.name as keyof typeof MIC_ERROR_BY_NAME] || 'Microphone access failed';
  }

  return 'Microphone access failed';
};

const getRecorderMimeType = (): string => (
  MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
);

type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

// Keep the permission stream for the lifetime of the page, not the lifetime of
// one composer mount. Chat state changes can remount the microphone button; a
// hook-local stream was then stopped and Safari asked for permission again on
// the next click. Disabled tracks retain the page grant without capturing audio.
let pageMicrophonePermissionStream: MediaStream | null = null;

const getSpeechRecognitionConstructor = () => {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
};

const resolveRecognitionLanguage = (language: string) => {
  if (language !== 'auto') return language;
  const pageLanguage = document.documentElement.lang || navigator.language || 'en-US';
  if (pageLanguage === 'en') return 'en-US';
  if (pageLanguage === 'ja') return 'ja-JP';
  if (pageLanguage === 'ko') return 'ko-KR';
  return pageLanguage;
};

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
const TRAILING_PUNCTUATION_PATTERN = /[，。！？；：,.!?;:]$/;

const joinRecognitionSegments = (segments: string[], finishSentence = false): string => {
  let output = '';
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    if (!output) {
      output = segment;
      continue;
    }
    const needsSeparator = !TRAILING_PUNCTUATION_PATTERN.test(output);
    const separator = needsSeparator
      ? (CJK_PATTERN.test(output) || CJK_PATTERN.test(segment) ? '，' : ' ')
      : (CJK_PATTERN.test(output) || CJK_PATTERN.test(segment) ? '' : ' ');
    output += `${separator}${segment}`;
  }

  if (finishSentence && output && !TRAILING_PUNCTUATION_PATTERN.test(output)) {
    output += CJK_PATTERN.test(output) ? '。' : '.';
  }
  return output;
};

export function useMicButtonController({
  onTranscript,
  language = 'auto',
}: UseMicButtonControllerArgs): UseMicButtonControllerResult {
  const [state, setState] = useState<MicButtonState>(MIC_BUTTON_STATES.IDLE);
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const lastTapRef = useRef(0);
  const processingTimerRef = useRef<number | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const recognitionActiveRef = useRef(false);
  const recognitionTextRef = useRef('');
  const recognitionFailedRef = useRef(false);
  const finalRecognitionSegmentsRef = useRef<Map<number, string>>(new Map());
  const interimRecognitionSegmentsRef = useRef<Map<number, string>>(new Map());
  const lastEmittedRecognitionRef = useRef('');

  const clearProcessingTimer = (): void => {
    if (processingTimerRef.current !== null) {
      window.clearTimeout(processingTimerRef.current);
      processingTimerRef.current = null;
    }
  };

  const stopStreamTracks = (): void => {
    if (!streamRef.current) {
      return;
    }

    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const ensurePageMicrophonePermission = async (): Promise<void> => {
    const existingStream = pageMicrophonePermissionStream;
    if (existingStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      existingStream.getAudioTracks().forEach((track) => { track.enabled = true; });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) return;

    // Keep one permission stream for this page lifetime. Safari otherwise may
    // treat every new SpeechRecognition instance as a fresh microphone request.
    pageMicrophonePermissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  };

  const handleStopRecording = async (mimeType: string): Promise<void> => {
    const audioBlob = new Blob(chunksRef.current, { type: mimeType });

    // Release the microphone immediately once recording ends.
    stopStreamTracks();
    setState(MIC_BUTTON_STATES.TRANSCRIBING);

    const whisperMode = window.localStorage.getItem('whisperMode') || DEFAULT_WHISPER_MODE;
    const shouldShowProcessingState = ENHANCEMENT_WHISPER_MODES.has(whisperMode);

    if (shouldShowProcessingState) {
      processingTimerRef.current = window.setTimeout(() => {
        setState(MIC_BUTTON_STATES.PROCESSING);
      }, PROCESSING_STATE_DELAY_MS);
    }

    try {
      const transcript = await transcribeWithWhisper(audioBlob, language);
      if (transcript && onTranscript) {
        onTranscript(transcript);
      }
    } catch (transcriptionError) {
      const message = transcriptionError instanceof Error ? transcriptionError.message : 'Transcription error';
      setError(message);
    } finally {
      clearProcessingTimer();
      setState(MIC_BUTTON_STATES.IDLE);
    }
  };

  const startRecording = async (): Promise<void> => {
    try {
      setError(null);
      chunksRef.current = [];

      if (!window.isSecureContext && window.location.protocol === 'http:') {
        window.location.assign('/switch-to-https');
        return;
      }

      const SpeechRecognition = getSpeechRecognitionConstructor();
      if (SpeechRecognition) {
        await ensurePageMicrophonePermission();
        recognitionTextRef.current = '';
        recognitionFailedRef.current = false;
        finalRecognitionSegmentsRef.current.clear();
        interimRecognitionSegmentsRef.current.clear();
        lastEmittedRecognitionRef.current = '';
        const recognition = recognitionRef.current || new SpeechRecognition();
        let recognitionEnded = false;
        recognition.lang = resolveRecognitionLanguage(language);
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = (event: any) => {
          if (recognitionEnded) return;
          interimRecognitionSegmentsRef.current.clear();
          for (let index = 0; index < event.results.length; index += 1) {
            const text = String(event.results[index]?.[0]?.transcript || '');
            if (!text.trim()) continue;
            if (event.results[index]?.isFinal) {
              finalRecognitionSegmentsRef.current.set(index, text);
            } else {
              interimRecognitionSegmentsRef.current.set(index, text);
            }
          }
          const orderedSegments = [
            ...Array.from(finalRecognitionSegmentsRef.current.entries()),
            ...Array.from(interimRecognitionSegmentsRef.current.entries()),
          ]
            .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
            .map(([, segment]) => segment);
          const fullText = joinRecognitionSegments(orderedSegments);
          recognitionTextRef.current = fullText || recognitionTextRef.current;
          if (fullText && fullText !== lastEmittedRecognitionRef.current) {
            lastEmittedRecognitionRef.current = fullText;
            onTranscript?.(fullText, false);
          }
        };
        recognition.onerror = (event: any) => {
          const errorCode = String(event.error || 'unknown');
          // Safari commonly emits `aborted` when recognition is stopped by the
          // user, a submit action, or a composer remount. It is a normal end
          // signal, not an actionable microphone failure.
          if (errorCode === 'aborted') {
            recognitionFailedRef.current = false;
            setError(null);
            return;
          }
          recognitionFailedRef.current = true;
          const errors: Record<string, string> = {
            'not-allowed': 'Microphone access denied. Please allow microphone permission.',
            'audio-capture': 'No microphone was found.',
            'no-speech': 'No speech was detected. Please try again.',
            network: 'Speech recognition service is unavailable.',
          };
          setError(errors[errorCode] || `Speech recognition failed: ${errorCode}`);
        };
        recognition.onend = () => {
          if (recognitionEnded) return;
          recognitionEnded = true;
          recognitionActiveRef.current = false;
          const transcript = joinRecognitionSegments(
            recognitionTextRef.current ? [recognitionTextRef.current] : [],
            true,
          );
          recognitionTextRef.current = '';
          finalRecognitionSegmentsRef.current.clear();
          interimRecognitionSegmentsRef.current.clear();
          lastEmittedRecognitionRef.current = '';
          pageMicrophonePermissionStream?.getAudioTracks().forEach((track) => { track.enabled = false; });
          if (!recognitionFailedRef.current && transcript) onTranscript?.(transcript, true);
          else onTranscript?.('', true);
          setState(MIC_BUTTON_STATES.IDLE);
        };
        recognitionRef.current = recognition;
        recognitionActiveRef.current = true;
        recognition.start();
        setState(MIC_BUTTON_STATES.RECORDING);
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(MIC_NOT_AVAILABLE_ERROR);
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = getRecorderMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        void handleStopRecording(mimeType);
      };

      recorder.start();
      setState(MIC_BUTTON_STATES.RECORDING);
    } catch (recordingError) {
      recognitionActiveRef.current = false;
      stopStreamTracks();
      pageMicrophonePermissionStream?.getAudioTracks().forEach((track) => { track.enabled = false; });
      setError(getRecordingErrorMessage(recordingError));
      setState(MIC_BUTTON_STATES.IDLE);
    }
  };

  const stopRecording = (): void => {
    if (recognitionRef.current && recognitionActiveRef.current) {
      setState(MIC_BUTTON_STATES.TRANSCRIBING);
      recognitionRef.current.stop();
      return;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      return;
    }

    stopStreamTracks();
    setState(MIC_BUTTON_STATES.IDLE);
  };

  const handleButtonClick = (event?: MouseEvent<HTMLButtonElement>): void => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (!isSupported) {
      if (!window.isSecureContext && window.location.protocol === 'http:') {
        window.location.assign('/switch-to-https');
      }
      return;
    }

    // Mobile tap handling can trigger duplicate click events in quick succession.
    const now = Date.now();
    if (now - lastTapRef.current < MIC_TAP_DEBOUNCE_MS) {
      return;
    }
    lastTapRef.current = now;

    if (state === MIC_BUTTON_STATES.IDLE) {
      void startRecording();
      return;
    }

    if (state === MIC_BUTTON_STATES.RECORDING) {
      stopRecording();
    }
  };

  useEffect(() => {
    // Safari may expose webkitSpeechRecognition on an insecure HTTP origin, but
    // still rejects microphone access. Treat every non-local HTTP origin as
    // unsupported so clicking the button can route through /switch-to-https.
    if (!window.isSecureContext && location.protocol === 'http:' && location.hostname !== 'localhost') {
      setIsSupported(false);
      setError(MIC_SECURE_CONTEXT_ERROR);
      return;
    }

    // Browser speech recognition does not need the MediaRecorder/Whisper
    // fallback. When unavailable, getUserMedia still requires a secure origin.
    if (getSpeechRecognitionConstructor()) {
      setIsSupported(true);
      setError(null);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setIsSupported(false);
      setError(MIC_NOT_SUPPORTED_ERROR);
      return;
    }

    setIsSupported(true);
    setError(null);
  }, []);

  useEffect(() => {
    const handleCommittedVoiceInput = () => {
      if (recognitionRef.current && recognitionActiveRef.current) {
        window.dispatchEvent(new Event('helix:voice-input-will-finalize'));
        setState(MIC_BUTTON_STATES.TRANSCRIBING);
        recognitionRef.current.stop();
        return;
      }
      if (mediaRecorderRef.current?.state === 'recording') {
        window.dispatchEvent(new Event('helix:voice-input-will-finalize'));
        mediaRecorderRef.current.stop();
      }
    };
    window.addEventListener('helix:voice-input-committed', handleCommittedVoiceInput);
    return () => window.removeEventListener('helix:voice-input-committed', handleCommittedVoiceInput);
  }, []);

  useEffect(() => () => {
    clearProcessingTimer();
    try { recognitionRef.current?.abort(); } catch { /* ignore */ }
    recognitionActiveRef.current = false;
    recognitionRef.current = null;
    stopStreamTracks();
    pageMicrophonePermissionStream?.getAudioTracks().forEach((track) => { track.enabled = false; });
  }, []);

  return {
    state,
    error,
    isSupported,
    handleButtonClick,
  };
}
