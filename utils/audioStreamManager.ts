// Persistent Audio and Microphone Manager
// Keeps the microphone stream and AudioContexts alive across all lesson pages
// ensuring smooth, continuous two-way conversation without reconnect friction.

let sharedMicrophoneStream: MediaStream | null = null;
let sharedInputAudioContext: AudioContext | null = null;
let sharedOutputAudioContext: AudioContext | null = null;
let micAcquisitionPromise: Promise<MediaStream> | null = null;

const AudioContextClass =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as any).webkitAudioContext
    : null;

/**
 * Resume all shared audio contexts.
 * Can be invoked synchronously inside user gestures (clicks, taps, page flips).
 */
export async function resumeSharedAudioContexts(): Promise<void> {
  if (sharedInputAudioContext && sharedInputAudioContext.state === 'suspended') {
    try {
      await sharedInputAudioContext.resume();
    } catch {
      // Ignore
    }
  }
  if (sharedOutputAudioContext && sharedOutputAudioContext.state === 'suspended') {
    try {
      await sharedOutputAudioContext.resume();
    } catch {
      // Ignore
    }
  }
}

// Auto-register touch/click listeners to unblock suspended audio contexts seamlessly
if (typeof window !== 'undefined') {
  const handleInteraction = () => {
    resumeSharedAudioContexts();
    // Warm up contexts if already constructed
    if (sharedInputAudioContext?.state === 'suspended') {
      sharedInputAudioContext.resume().catch(() => {});
    }
    if (sharedOutputAudioContext?.state === 'suspended') {
      sharedOutputAudioContext.resume().catch(() => {});
    }
  };
  window.addEventListener('click', handleInteraction, { passive: true });
  window.addEventListener('touchstart', handleInteraction, { passive: true });
  window.addEventListener('keydown', handleInteraction, { passive: true });
  window.addEventListener('pointerdown', handleInteraction, { passive: true });
}

/**
 * Get or initialize the persistent 16kHz AudioContext for user microphone streaming.
 */
export function getSharedInputAudioContext(): AudioContext {
  if (!AudioContextClass) {
    throw new Error('Web Audio API is not supported in this browser.');
  }

  if (!sharedInputAudioContext || sharedInputAudioContext.state === 'closed') {
    try {
      sharedInputAudioContext = new AudioContextClass({ sampleRate: 16000 });
    } catch {
      sharedInputAudioContext = new AudioContextClass();
    }
  }

  if (sharedInputAudioContext.state === 'suspended') {
    sharedInputAudioContext.resume().catch(() => {});
  }

  return sharedInputAudioContext;
}

/**
 * Get or initialize the persistent 24kHz AudioContext for AI speech playback.
 */
export function getSharedOutputAudioContext(): AudioContext {
  if (!AudioContextClass) {
    throw new Error('Web Audio API is not supported in this browser.');
  }

  if (!sharedOutputAudioContext || sharedOutputAudioContext.state === 'closed') {
    try {
      sharedOutputAudioContext = new AudioContextClass({ sampleRate: 24000 });
    } catch {
      sharedOutputAudioContext = new AudioContextClass();
    }
  }

  if (sharedOutputAudioContext.state === 'suspended') {
    sharedOutputAudioContext.resume().catch(() => {});
  }

  return sharedOutputAudioContext;
}

/**
 * Get or acquire the persistent microphone stream.
 * If already active, returns immediately without requesting permissions again.
 * Reuses the single global MediaStream across all 15 lesson pages.
 */
export async function getSharedMicrophoneStream(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Trình duyệt không hỗ trợ thu âm micro.');
  }

  // Check if existing stream has active tracks
  if (sharedMicrophoneStream) {
    const audioTracks = sharedMicrophoneStream.getAudioTracks();
    const isLive = audioTracks.some((t) => t.readyState === 'live');
    if (isLive) {
      audioTracks.forEach((t) => {
        t.enabled = true;
      });
      return sharedMicrophoneStream;
    }
  }

  // If already in flight, reuse existing acquisition promise
  if (micAcquisitionPromise) {
    return micAcquisitionPromise;
  }

  micAcquisitionPromise = (async () => {
    try {
      // Request high-quality speech microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      // Keep tracks enabled
      stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
        track.onended = () => {
          // If track ended unexpectedly, reset so next get call can recreate
          if (sharedMicrophoneStream === stream) {
            sharedMicrophoneStream = null;
          }
        };
      });

      sharedMicrophoneStream = stream;
      return stream;
    } finally {
      micAcquisitionPromise = null;
    }
  })();

  return micAcquisitionPromise;
}

/**
 * Checks if the persistent microphone stream is currently active.
 */
export function isMicrophoneStreamActive(): boolean {
  if (!sharedMicrophoneStream) return false;
  return sharedMicrophoneStream.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled);
}

/**
 * Pre-warm audio contexts and pre-acquire microphone stream on user gesture.
 */
export async function autoPrepareAudioAndMic(): Promise<void> {
  await resumeSharedAudioContexts();
  try {
    getSharedInputAudioContext();
    getSharedOutputAudioContext();
    if (navigator.mediaDevices?.getUserMedia) {
      await getSharedMicrophoneStream();
    }
  } catch {
    // If not allowed yet, user will be prompted inside the lesson room
  }
}

/**
 * Optional cleanup for full app teardown.
 */
export function releaseSharedAudio(): void {
  if (sharedMicrophoneStream) {
    sharedMicrophoneStream.getTracks().forEach((track) => track.stop());
    sharedMicrophoneStream = null;
  }
  if (sharedInputAudioContext && sharedInputAudioContext.state !== 'closed') {
    sharedInputAudioContext.close().catch(() => {});
    sharedInputAudioContext = null;
  }
  if (sharedOutputAudioContext && sharedOutputAudioContext.state !== 'closed') {
    sharedOutputAudioContext.close().catch(() => {});
    sharedOutputAudioContext = null;
  }
}

