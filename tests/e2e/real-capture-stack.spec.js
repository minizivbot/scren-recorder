/**
 * Drives the app with a MediaStream produced by Chrome's real video capture
 * pipeline, rather than by a canvas.
 *
 * Why this exists: display capture cannot be started in this container (the X11
 * screen capturer initialises — SHM segment, MIT-SHM v1.2, XRandR v1.6 — and
 * then device launch fails with error 31; tab capture fails identically). A
 * fake camera device, however, launches fine. So getUserMedia gives a track
 * that came out of the same capture stack a real screen share would use:
 * a platform-produced track with real constraints, real settings, and a real
 * device-level 'ended', rather than a canvas pretending to be one.
 *
 * The other specs use a canvas because they need to verify frame CONTENT
 * against known timestamps, which a fake camera cannot provide. This one
 * verifies the app handles a genuine capture-stack track.
 */
import { test, expect } from '@playwright/test';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

/**
 * Substitutes the capture SOURCE only: a real camera track stands in for a real
 * screen track. Everything the app does with it is untouched.
 */
const CAMERA_AS_DISPLAY = `
navigator.mediaDevices.getDisplayMedia = (constraints = {}) => {
  const v = constraints.video || {};
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: v.width?.ideal || 1280,
      height: v.height?.ideal || 720,
      frameRate: v.frameRate?.ideal || 10,
    },
    audio: false,
  });
};
`;

test('records and reviews a stream from the real capture pipeline', async ({ page }) => {
  await page.addInitScript(CAMERA_AS_DISPLAY);
  await page.goto('/');

  await page.click('#btn-record');
  await page.waitForFunction(() => window.tradeJournal?.state === 'recording');

  await page.locator('body').press('e');
  await page.waitForTimeout(5000);
  await page.locator('body').press('x');
  await page.waitForTimeout(4000);

  const sessionId = await page.evaluate(() => window.tradeJournal.sessionId);
  await page.click('#btn-record');
  await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'idle');

  const session = await page.evaluate(async (id) => {
    const { getSession } = await import('/src/session-recorder.js');
    return getSession(id);
  }, sessionId);

  expect(session.status).toBe('complete');
  expect(session.chunkCount).toBeGreaterThan(2);
  expect(session.bytes).toBeGreaterThan(10_000);
  expect(session.markers).toHaveLength(2);
  // Resolution recorded from the track's own getSettings(), not from our request.
  expect(session.video.width).toBeGreaterThan(0);
  expect(session.video.height).toBeGreaterThan(0);

  // And it plays back and seeks.
  await page.locator(`.session[data-session-id="${sessionId}"]`).click();
  await expect(page.locator('#video-overlay')).toBeHidden();

  await page.click('#btn-play');
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0.5);
  await page.click('#btn-play');

  await page.fill('#review-preroll', '2');
  await page.dispatchEvent('#review-preroll', 'change');
  await page.locator('#review-marker-list li').nth(1).click();
  await page.waitForFunction(() => !document.getElementById('player').seeking);

  const currentTime = await page.evaluate(() => document.getElementById('player').currentTime);
  const expected = (session.markers[1].offsetMs - 2000) / 1000;
  expect(Math.abs(currentTime - expected)).toBeLessThan(1.0);
});
