type AudioContextConstructor = new () => AudioContext;

type AudioWindow = Window & {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
};

export type NotificationChime = {
  unlock: () => void;
  play: () => void;
  close: () => void;
};

export function createNotificationChime(): NotificationChime {
  let context: AudioContext | null = null;
  let closed = false;

  const getContext = () => {
    if (closed) return null;
    if (context) return context;
    const audioWindow = window as AudioWindow;
    const AudioContextClass =
      audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      context = new AudioContextClass();
      return context;
    } catch {
      return null;
    }
  };

  const unlock = () => {
    const audioContext = getContext();
    if (audioContext?.state === 'suspended') {
      void audioContext.resume().catch(() => undefined);
    }
  };

  const play = () => {
    const audioContext = getContext();
    if (!audioContext || audioContext.state === 'closed') return;
    if (audioContext.state === 'suspended') {
      const requestedAt = Date.now();
      void audioContext
        .resume()
        .then(() => {
          if (!closed && Date.now() - requestedAt < 250) {
            safeScheduleChime(audioContext);
          }
        })
        .catch(() => undefined);
      return;
    }
    safeScheduleChime(audioContext);
  };

  const close = () => {
    closed = true;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => undefined);
    }
    context = null;
  };

  return { unlock, play, close };
}

function safeScheduleChime(context: AudioContext) {
  try {
    scheduleChime(context);
  } catch {
    // Sound is supplemental feedback and must never interrupt toast delivery.
  }
}

function scheduleChime(context: AudioContext) {
  const now = context.currentTime;
  scheduleNote(context, 659.25, now, 0.26, 0.045);
  scheduleNote(context, 880, now + 0.09, 0.32, 0.035);
}

function scheduleNote(
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  volume: number,
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration);
}
