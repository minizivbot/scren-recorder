/**
 * Definition of done #5 and #9: a refresh mid-session must cost at most one
 * timeslice and leave a playable session, and ending the capture from the
 * browser's own "Stop sharing" bar must finalize rather than corrupt.
 */
import { test, expect, saveSessionToDisk, waitForRecording, gotoView } from './fixtures.js';
import { parseWebmFile } from './webm.js';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'test-results', 'recordings');

test('a refresh mid-session leaves a recoverable, playable partial session', async ({ page }) => {
  await page.goto('/');
  await page.click('#btn-record');
  await waitForRecording(page);

  await page.locator('body').press('e');
  await page.waitForTimeout(2500);
  await page.locator('body').press('x');

  const { sessionId, elapsedMs } = await page.evaluate(() => ({
    sessionId: window.tradeJournal.sessionId,
    elapsedMs: window.tradeJournal.markers.at(-1).offsetMs,
  }));

  // Let a couple more timeslices land so there is a real prefix on disk.
  await page.waitForTimeout(5000);

  // The tab goes away without stop() ever being called.
  await page.evaluate(() => window.stop());
  await page.reload();

  // recoverInterruptedSessions() uses a staleness heartbeat so it cannot steal
  // a session another tab is recording; wait past it, then reload again.
  await page.waitForTimeout(16_000);
  await page.reload();

  await gotoView(page, 'recordings');
  const row = page.locator(`.session[data-session-id="${sessionId}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.badge-interrupted')).toBeVisible();

  const session = await page.evaluate(async (id) => {
    const { getSession } = await import('/src/session-recorder.js');
    return getSession(id);
  }, sessionId);

  expect(session.status).toBe('interrupted');
  expect(session.markers).toHaveLength(2);
  expect(session.markers[1].offsetMs).toBeCloseTo(elapsedMs, -2);
  expect(session.chunkCount).toBeGreaterThan(1);

  // At most one timeslice is missing between the last marker and the cut.
  const timeslice = session.options.timesliceMs;
  expect(session.durationMs).toBeGreaterThan(elapsedMs - timeslice);

  // The partial file is a structurally valid webm, not a truncated mess.
  const file = path.join(OUT, `${sessionId}-interrupted.webm`);
  await saveSessionToDisk(page, sessionId, file);
  const webm = await parseWebmFile(file);
  expect(webm.error).toBeNull();
  expect(webm.clean).toBe(true);
  expect(webm.blocks).toBeGreaterThan(10);

  // And it plays.
  await row.click();
  await expect(page.locator('#video-overlay')).toBeHidden();
  await page.click('#btn-play');
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0.3);
});

test('ending the capture from the browser bar finalizes the session', async ({ page }) => {
  await page.goto('/');
  await page.click('#btn-record');
  await waitForRecording(page);

  await page.locator('body').press('e');
  await page.waitForTimeout(4000);

  const sessionId = await page.evaluate(() => window.tradeJournal.sessionId);

  // Chrome's own "Stop sharing" bar ends the track. The app's stop button is
  // never touched, so only the track's 'ended' event can finalize this.
  await page.evaluate(() => window.__stopSharingFromBrowserBar());

  await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#alert-banner')).toContainText('stopped from the browser bar');

  // Ending this way still offers the review, same as pressing stop.
  await expect(page.locator('.wizard')).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();

  const session = await page.evaluate(async (id) => {
    const { getSession } = await import('/src/session-recorder.js');
    return getSession(id);
  }, sessionId);

  expect(session.status).toBe('complete');
  expect(session.complete).toBe(true);
  expect(session.endedAt).toBeGreaterThan(session.startedAt);
  expect(session.durationMs).toBeGreaterThan(3000);
  expect(session.markers).toHaveLength(1);

  const file = path.join(OUT, `${sessionId}-browserbar.webm`);
  await saveSessionToDisk(page, sessionId, file);
  const webm = await parseWebmFile(file);
  expect(webm.error).toBeNull();
  expect(webm.clean).toBe(true);
  expect(webm.keyframes).toBeGreaterThan(0);

  // It appears in the library and plays back.
  await gotoView(page, 'recordings');
  const row = page.locator(`.session[data-session-id="${sessionId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('#video-overlay')).toBeHidden();
  await page.click('#btn-play');
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0.3);
});
