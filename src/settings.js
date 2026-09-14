/**
 * User settings, persisted in localStorage.
 *
 * The capture defaults are deliberate: charts are near-static, so 10fps costs
 * almost nothing visually and saves enormously. The bitrate is the setting that
 * matters — drop it too far and chart text stops being readable, which makes
 * the recording useless for the one thing it exists for. If a session needs to
 * be smaller, reduce bitrate before reducing resolution.
 */

const KEY = 'trade-journal:settings';

export const DEFAULTS = {
  // Capture
  width: 1280,
  height: 720,
  frameRate: 10,
  videoBitsPerSecond: 1_500_000,
  timesliceMs: 2000,

  // Review. Seeking lands this far BEFORE the marker, because the setup is what
  // is being reviewed — by the time the hotkey is pressed the decision is made.
  preRollMs: 90_000,

  // Marking. Only fires while this tab is focused; see the notice in the UI.
  hotkeys: {
    entry: 'e',
    exit: 'x',
    note: 'n',
  },

  // The ticket the next trade opens with. Kept because a session is usually
  // spent on one or two instruments, so the answer to "which pair?" is nearly
  // always the same one you said last time.
  ticket: {
    symbol: '',
    direction: '',
    account: '',
  },

  // Instruments you have actually traded here, offered as suggestions.
  instruments: [],
};

/** Most recent first, de-duplicated, and bounded — it is a suggestion list. */
export function rememberInstrument(settings, symbol) {
  const clean = String(symbol || '').trim().toUpperCase();
  if (!clean) return settings.instruments || [];
  return [clean, ...(settings.instruments || []).filter((s) => s !== clean)].slice(0, 12);
}

export const PRESETS = [
  { label: '720p · 10fps · 1.5 Mbps (default)', width: 1280, height: 720, frameRate: 10, videoBitsPerSecond: 1_500_000 },
  { label: '720p · 10fps · 1.0 Mbps (smaller)', width: 1280, height: 720, frameRate: 10, videoBitsPerSecond: 1_000_000 },
  { label: '720p · 5fps · 1.5 Mbps (static charts)', width: 1280, height: 720, frameRate: 5, videoBitsPerSecond: 1_500_000 },
  { label: '1080p · 10fps · 2.5 Mbps (sharper text)', width: 1920, height: 1080, frameRate: 10, videoBitsPerSecond: 2_500_000 },
];

export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      ...DEFAULTS,
      ...stored,
      hotkeys: { ...DEFAULTS.hotkeys, ...(stored.hotkeys || {}) },
      ticket: { ...DEFAULTS.ticket, ...(stored.ticket || {}) },
      instruments: Array.isArray(stored.instruments) ? stored.instruments : [],
    };
  } catch {
    return {
      ...DEFAULTS,
      hotkeys: { ...DEFAULTS.hotkeys },
      ticket: { ...DEFAULTS.ticket },
      instruments: [],
    };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
  return settings;
}

/**
 * Bitrate is what determines size — frame rate and resolution only change how
 * hard the encoder has to work to hit it.
 */
export function estimateBytesPerHour(settings) {
  return (settings.videoBitsPerSecond / 8) * 3600;
}

export function captureOptions(settings) {
  const { width, height, frameRate, videoBitsPerSecond, timesliceMs } = settings;
  return { width, height, frameRate, videoBitsPerSecond, timesliceMs };
}
