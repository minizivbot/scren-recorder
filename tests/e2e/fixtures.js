import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const FFMPEG = '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux';

/**
 * Replaces ONLY the OS capture source.
 *
 * This container has no display capture source, so getDisplayMedia returns
 * NotReadableError. Everything downstream of the source is left completely
 * real: a real MediaStream, a real MediaRecorder doing real VP8/VP9 encoding,
 * real timeslice chunks, real IndexedDB, real reassembly and real playback in a
 * real <video>. Only the frames' origin is synthetic.
 *
 * The frames carry the elapsed second encoded as an 8-bit black/white barcode,
 * which survives lossy compression. That is what makes it possible to prove a
 * seek landed on the frame the marker points at, rather than merely proving
 * currentTime was assigned.
 */
export const CAPTURE_DOUBLE = `
(() => {
  const SQUARE = 44;
  const BITS = 8;

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  window.__capture = { startedAt: null, frames: 0, canvas: null };

  navigator.mediaDevices.getDisplayMedia = async (constraints = {}) => {
    const video = constraints.video || {};
    const width = video.width?.ideal || 1280;
    const height = video.height?.ideal || 720;
    const fps = video.frameRate?.ideal || 10;

    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const startedAt = performance.now();
    window.__capture.startedAt = startedAt;
    window.__capture.canvas = canvas;

    const draw = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const second = Math.floor(elapsed);

      ctx.fillStyle = '#202830';
      ctx.fillRect(0, 0, width, height);

      // Barcode: 8 squares, MSB first, pure black/white so lossy encoding
      // cannot blur one value into another.
      for (let bit = 0; bit < BITS; bit++) {
        const on = (second >> (BITS - 1 - bit)) & 1;
        ctx.fillStyle = on ? '#ffffff' : '#000000';
        ctx.fillRect(20 + bit * (SQUARE + 10), 20, SQUARE, SQUARE);
      }

      // Human-readable, for screenshots.
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 64px monospace';
      ctx.fillText('t=' + elapsed.toFixed(2) + 's', 20, 180);

      // Something that actually changes every frame, so the encoder has work to
      // do and the bitrate is not trivially compressible to nothing.
      ctx.fillStyle = 'hsl(' + ((window.__capture.frames * 7) % 360) + ',70%,50%)';
      ctx.fillRect(20, 220, 400 + Math.sin(elapsed) * 200, 60);

      window.__capture.frames++;
    };

    draw();
    const timer = setInterval(draw, 1000 / fps);

    const stream = canvas.captureStream(fps);
    const track = stream.getVideoTracks()[0];

    const realStop = track.stop.bind(track);
    track.stop = () => { clearInterval(timer); realStop(); };

    // Stands in for the user pressing Chrome's own "Stop sharing" bar, which
    // ends the track without the app's UI being involved at all.
    window.__stopSharingFromBrowserBar = () => {
      clearInterval(timer);
      realStop();
      track.dispatchEvent(new Event('ended'));
    };

    return stream;
  };
})();
`;

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(CAPTURE_DOUBLE);
    page.on('pageerror', (err) => console.error('[page error]', err.message));
    await use(page);
  },
});

export { expect };

/** Reads the barcode out of a rendered video frame. */
export async function decodeFrameSecond(page) {
  return page.evaluate(() => {
    const video = document.getElementById('player');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);

    const SQUARE = 44;
    const BITS = 8;
    let value = 0;
    for (let bit = 0; bit < BITS; bit++) {
      const x = 20 + bit * (SQUARE + 10) + SQUARE / 2;
      const y = 20 + SQUARE / 2;
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      const on = (r + g + b) / 3 > 127;
      value = (value << 1) | (on ? 1 : 0);
    }
    return value;
  });
}

/** Pulls a stored session out of IndexedDB and writes it to disk. */
export async function saveSessionToDisk(page, sessionId, filePath) {
  const base64 = await page.evaluate(async (id) => {
    const { getSessionBlob } = await import('/src/session-recorder.js');
    const blob = await getSessionBlob(id);
    if (!blob) return null;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }, sessionId);

  if (!base64) return null;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

/**
 * Reads stream metadata with ffmpeg.
 *
 * The ffmpeg bundled here is a stripped build: VP8 decode only, and no muxers
 * beyond webm/image2. It can report what the stream is, and it can fully decode
 * a VP8 recording (see the frame-accuracy spec), but it cannot process the VP9
 * the app produces by default. Structural validation of VP9 output is done by
 * parseWebmFile instead, and pixel-level proof by Chrome's own playback.
 */
export async function probeWithFfmpeg(filePath) {
  const { stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-i', filePath])
    .catch((err) => ({ stderr: err.stderr || String(err) }));

  const video = /Video:\s*(\w+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  return {
    stderr,
    codec: video?.[1] ?? null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
    // MediaRecorder cannot know where the file ends, so it writes no duration.
    // This is expected, and is exactly why the player resolves duration itself.
    declaresDuration: !/Duration:\s*N\/A/.test(stderr),
    hasDecodeErrors: /Invalid data found|corrupt|could not find codec/i.test(stderr),
  };
}

/** Decodes a VP8 recording to PNG frames so their content can be inspected. */
export async function decodeFramesToPng(filePath, outDir, { fps = 1 } = {}) {
  await fs.mkdir(outDir, { recursive: true });
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-i', filePath,
    '-vf', `fps=${fps}`,
    '-f', 'image2', '-y', path.join(outDir, 'frame-%04d.png'),
  ], { maxBuffer: 64 * 1024 * 1024 });

  const files = (await fs.readdir(outDir)).filter((f) => f.endsWith('.png')).sort();
  return files.map((f) => path.join(outDir, f));
}

/** Waits until the app reports it is recording. */
export async function waitForRecording(page) {
  await page.waitForFunction(() => window.tradeJournal?.state === 'recording');
}
