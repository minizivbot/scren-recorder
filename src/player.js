/**
 * Playback helpers for MediaRecorder output.
 *
 * The thing to know: a webm produced by MediaRecorder has no duration in its
 * header and no cue index, because the encoder is streaming and does not know
 * where the file ends. A freshly loaded blob therefore reports
 * `duration === Infinity`, the native scrubber is unusable, and seeking is
 * unreliable until the browser has scanned the file.
 *
 * Since the whole review flow is "seek to a marker", that has to be dealt with
 * rather than worked around. Two halves:
 *
 *  1. Force the browser to establish the real duration by seeking past the end
 *     once, on load. After that scan, seeking within the file behaves normally.
 *  2. Never depend on it anyway for display: the recorder already stored a
 *     duration derived from the chunks on disk, which is correct even for a
 *     session that was interrupted and never finalized.
 */

/** How long to wait for the browser to work out the duration before giving up. */
const DURATION_TIMEOUT_MS = 8000;

/**
 * Makes a MediaRecorder blob seekable and returns its duration in seconds.
 *
 * Seeking to an absurd time makes the browser scan to the end of the stream, at
 * which point it knows the duration and can seek within it. This is the
 * standard remedy for header-less webm and it is why review works at all.
 */
export function resolveDuration(video, { fallbackMs = 0, timeoutMs = DURATION_TIMEOUT_MS } = {}) {
  const fallbackSeconds = fallbackMs / 1000;

  return new Promise((resolve) => {
    if (isUsableDuration(video.duration)) {
      resolve(video.duration);
      return;
    }

    let settled = false;
    const finish = (seconds) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Put the playhead back; the scan left it at the end of the file.
      try { video.currentTime = 0; } catch { /* not seekable yet; harmless */ }
      resolve(seconds);
    };

    const onDurationChange = () => {
      if (isUsableDuration(video.duration)) finish(video.duration);
    };

    const cleanup = () => {
      video.removeEventListener('durationchange', onDurationChange);
      clearTimeout(timer);
    };

    const timer = setTimeout(() => finish(fallbackSeconds), timeoutMs);
    video.addEventListener('durationchange', onDurationChange);

    try {
      // Any time far past the end will do; the browser clamps it.
      video.currentTime = 1e101;
    } catch {
      finish(fallbackSeconds);
    }
  });
}

function isUsableDuration(d) {
  return Number.isFinite(d) && d > 0;
}

/**
 * Seeks and resolves once the frame at that position is actually showing, so
 * callers can rely on the picture matching the marker.
 */
export function seekTo(video, seconds, { timeoutMs = 5000 } = {}) {
  const target = Math.max(0, seconds);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve(video.currentTime);
    };

    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener('seeked', finish);

    try {
      video.currentTime = target;
    } catch {
      finish();
    }
  });
}

/**
 * Loads a session blob into a video element and prepares it for seeking.
 * Returns the object URL so the caller can revoke it — a 1.3 GB blob that stays
 * referenced is a 1.3 GB leak.
 */
export async function loadSessionIntoVideo(video, blob, { fallbackMs = 0 } = {}) {
  const url = URL.createObjectURL(blob);
  video.src = url;

  await new Promise((resolve) => {
    if (video.readyState >= 1) { resolve(); return; }
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', resolve, { once: true });
  });

  const durationSeconds = await resolveDuration(video, { fallbackMs });
  return { url, durationSeconds };
}
