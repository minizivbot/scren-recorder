/**
 * The definition of done, walked end to end in a real browser:
 * start → mark → stop → library → play → seek to marker with pre-roll.
 *
 * The frames carry an encoded timestamp, so "the seek landed correctly" is
 * proved from the decoded picture, not from the value of currentTime.
 */
import { test, expect, decodeFrameSecond, saveSessionToDisk, probeWithFfmpeg, waitForRecording, stopAndSkipReview, gotoView } from './fixtures.js';
import { parseWebmFile } from './webm.js';
import path from 'node:path';
import fs from 'node:fs/promises';

const OUT = path.join(process.cwd(), 'test-results', 'recordings');

test('records a session, marks it live, and reviews it with pre-roll', async ({ page }) => {
  await page.goto('/');

  // ── 1. start ──────────────────────────────────────────────────────────
  await page.click('#btn-record');
  await waitForRecording(page);

  await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'recording');
  await expect(page.locator('#status-text')).toHaveText('RECORDING');
  await expect(page.locator('#elapsed')).toBeVisible();
  await expect(page.locator('#btn-record-label')).toHaveText('Stop recording');

  // The elapsed timer actually advances.
  const firstElapsed = await page.locator('#elapsed').textContent();
  await page.waitForTimeout(2200);
  expect(await page.locator('#elapsed').textContent()).not.toBe(firstElapsed);

  // ── 2. mark with the hotkey while the tab is focused ──────────────────
  await page.locator('body').press('e'); // entry
  await expect(page.locator('#live-marker-list li')).toHaveCount(1);
  await expect(page.locator('#live-marker-count')).toHaveText('1');

  await page.waitForTimeout(4000);
  await page.locator('body').press('x'); // exit
  await expect(page.locator('#live-marker-list li')).toHaveCount(2);

  await page.waitForTimeout(3000);
  await page.locator('body').press('n'); // note
  await expect(page.locator('#live-marker-list li')).toHaveCount(3);

  // Markers show their offset into the recording immediately.
  const shown = await page.locator('#live-marker-list .marker-time').allTextContents();
  expect(shown.every((t) => /^\d{2}:\d{2}$/.test(t))).toBe(true);

  const liveMarkers = await page.evaluate(() => window.tradeJournal.markers);
  expect(liveMarkers).toHaveLength(3);
  expect(liveMarkers.map((m) => m.kind)).toEqual(['entry', 'exit', 'note']);
  // Offsets are strictly increasing and match the waits.
  expect(liveMarkers[1].offsetMs - liveMarkers[0].offsetMs).toBeGreaterThan(3500);
  expect(liveMarkers[2].offsetMs - liveMarkers[1].offsetMs).toBeGreaterThan(2500);

  // Let the recording run well past the last marker so pre-roll has room.
  await page.waitForTimeout(4000);

  // ── 3. stop → the session appears in the library ──────────────────────
  const sessionId = await page.evaluate(() => window.tradeJournal.sessionId);
  await stopAndSkipReview(page);
  await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'idle');

  await gotoView(page, 'recordings');
  const row = page.locator(`.session[data-session-id="${sessionId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('3');
  await expect(page.locator('#session-count')).toHaveText('1');

  // ── 4. the file is genuinely decodable ────────────────────────────────
  const file = path.join(OUT, `${sessionId}.webm`);
  await saveSessionToDisk(page, sessionId, file);
  const probe = await probeWithFfmpeg(file);

  expect(probe.codec).toMatch(/vp8|vp9/);
  expect(probe.hasDecodeErrors).toBe(false);
  expect(probe.width).toBe(1280);
  expect(probe.height).toBe(720);
  // MediaRecorder writes no duration, which is why the player resolves it.
  expect(probe.declaresDuration).toBe(false);

  // Structural check: if the chunks had been reassembled out of order the bytes
  // would all still be here and only the element structure would break.
  const webm = await parseWebmFile(file);
  expect(webm.error).toBeNull();
  expect(webm.clean).toBe(true);
  expect(webm.hasEbmlHeader).toBe(true);
  expect(webm.hasTracks).toBe(true);
  expect(webm.keyframes).toBeGreaterThan(0);
  // ~10fps across a >13s recording.
  expect(webm.blocks).toBeGreaterThan(100);
  expect((await fs.stat(file)).size).toBeGreaterThan(20_000);

  // ── 5. open it and play ───────────────────────────────────────────────
  await row.click();
  await expect(page.locator('#view-review')).toBeVisible();
  await expect(page.locator('#video-overlay')).toBeHidden();
  await expect(page.locator('#review-marker-list li')).toHaveCount(3);

  await page.click('#btn-play');
  await page.waitForFunction(() => document.getElementById('player').currentTime > 0.5);
  await page.click('#btn-play'); // pause

  // ── 6. clicking a marker seeks to it with the pre-roll applied ────────
  const preRollMs = await page.evaluate(() => window.tradeJournal.settings.preRollMs);
  expect(preRollMs).toBe(90_000);

  // With a 90s pre-roll every marker in this short session clamps to 0, which
  // is itself the correct behaviour. Shorten it so the offset is observable.
  await expect(page.locator('#review-preroll')).toHaveValue('90');
  await page.fill('#review-preroll', '3');
  await page.dispatchEvent('#review-preroll', 'change');
  expect(await page.evaluate(() => window.tradeJournal.settings.preRollMs)).toBe(3000);

  const exitMarker = liveMarkers[1];
  await page.locator('#review-marker-list li').nth(1).click();
  await page.waitForFunction(() => !document.getElementById('player').seeking);

  const currentTime = await page.evaluate(() => document.getElementById('player').currentTime);
  const expectedSeconds = (exitMarker.offsetMs - 3000) / 1000;
  expect(currentTime).toBeGreaterThan(0);
  expect(Math.abs(currentTime - expectedSeconds)).toBeLessThan(1.0);

  // The picture itself proves it: the frame showing is the one from that moment.
  const decodedSecond = await decodeFrameSecond(page);
  expect(Math.abs(decodedSecond - expectedSeconds)).toBeLessThanOrEqual(2);

  await page.screenshot({ path: path.join(OUT, 'seek-to-marker.png') });
});
