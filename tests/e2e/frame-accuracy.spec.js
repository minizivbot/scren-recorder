/**
 * Independent verification that the reassembled file contains the right
 * pictures at the right times.
 *
 * Everywhere else, the same browser that wrote the recording is the one reading
 * it back — which would not catch a file that only Chrome can make sense of.
 * Here ffmpeg decodes the video and the frames are checked in Node against the
 * timestamps burned into them at capture time.
 *
 * This forces VP8, because the ffmpeg bundled in this environment is a stripped
 * build with no VP9 decoder. The app's own default remains VP9.
 */
import { test, expect, saveSessionToDisk, decodeFramesToPng, waitForRecording } from './fixtures.js';
import { readGrayPng, decodeBarcode } from './png.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG } from './fixtures.js';

const execFileAsync = promisify(execFile);
const OUT = path.join(process.cwd(), 'test-results', 'recordings');

const FORCE_VP8 = `
(() => {
  const real = MediaRecorder.isTypeSupported.bind(MediaRecorder);
  MediaRecorder.isTypeSupported = (type) => type === 'video/webm;codecs=vp8' && real(type);
})();
`;

test('the stored file decodes, outside the browser, to the frames it should contain', async ({ page }) => {
  await page.addInitScript(FORCE_VP8);
  await page.goto('/');

  await page.click('#btn-record');
  await waitForRecording(page);
  await page.waitForTimeout(12_000);
  const sessionId = await page.evaluate(() => window.tradeJournal.sessionId);
  await page.click('#btn-record');
  await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'idle');

  const session = await page.evaluate(async (id) => {
    const { getSession } = await import('/src/session-recorder.js');
    return getSession(id);
  }, sessionId);
  expect(session.mimeType).toContain('vp8');
  // A 12s session at a 2s timeslice is several chunks, so this really is
  // testing reassembly and not a single-blob passthrough.
  expect(session.chunkCount).toBeGreaterThanOrEqual(5);

  const file = path.join(OUT, `${sessionId}-vp8.webm`);
  await saveSessionToDisk(page, sessionId, file);

  // Decode every frame to greyscale PNG. No -vf here: this ffmpeg is built with
  // almost no filters, so frames are taken as they come and sampled below.
  const frameDir = path.join(OUT, `${sessionId}-frames`);
  await fs.mkdir(frameDir, { recursive: true });
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-i', file,
    '-pix_fmt', 'gray',
    '-f', 'image2', '-y', path.join(frameDir, 'frame-%04d.png'),
  ], { maxBuffer: 64 * 1024 * 1024 });

  const frames = (await fs.readdir(frameDir)).filter((f) => f.endsWith('.png')).sort();
  const fps = session.options.frameRate;
  // ~10fps over ~12s, less whatever the encoder dropped.
  expect(frames.length).toBeGreaterThan(fps * 8);

  // Every frame carries the second it was captured at. Read them all back.
  const decoded = [];
  for (const name of frames) {
    const image = await readGrayPng(path.join(frameDir, name));
    expect(image.width).toBe(1280);
    expect(image.height).toBe(720);
    decoded.push(decodeBarcode(image));
  }

  // Time only ever moves forward. Chunks reassembled out of order would show up
  // here as the timestamp jumping backwards partway through the file.
  for (let i = 1; i < decoded.length; i++) {
    expect(decoded[i]).toBeGreaterThanOrEqual(decoded[i - 1]);
  }

  // And it advances at real time: one second per second of footage, with no
  // stalls or repeats, which is what a missing chunk would look like.
  const span = decoded.at(-1) - decoded[0];
  expect(span).toBeGreaterThanOrEqual(Math.floor(frames.length / fps) - 2);
  expect(span).toBeLessThanOrEqual(Math.ceil(frames.length / fps) + 1);

  for (let i = fps; i < decoded.length; i += fps) {
    const secondsElapsed = i / fps;
    expect(Math.abs((decoded[i] - decoded[0]) - secondsElapsed)).toBeLessThanOrEqual(1);
  }
});
