/**
 * Definition of done #7 and #8: markers can be edited after recording and added
 * while scrubbing, and deleting a session measurably frees space.
 */
import { test, expect, waitForRecording } from './fixtures.js';

async function recordShortSession(page, { seconds = 8 } = {}) {
  await page.click('#btn-record');
  await waitForRecording(page);
  await page.locator('body').press('e');
  await page.waitForTimeout(seconds * 1000);
  const sessionId = await page.evaluate(() => window.tradeJournal.sessionId);
  await page.click('#btn-record');
  await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'idle');
  return sessionId;
}

test('markers can be edited and new ones added by scrubbing', async ({ page }) => {
  await page.goto('/');
  const sessionId = await recordShortSession(page);

  await page.locator(`.session[data-session-id="${sessionId}"]`).click();
  await expect(page.locator('#review-marker-list li')).toHaveCount(1);

  // ── edit an existing marker ───────────────────────────────────────────
  await page.locator('#review-marker-list li').first().getByText('Edit').click();
  await page.selectOption('select[name="kind"]', 'entry');
  await page.fill('input[name="symbol"]', 'MNQ');
  await page.selectOption('select[name="direction"]', 'long');
  await page.selectOption('select[name="account"]', 'paper');
  await page.fill('textarea[name="note"]', 'failed breakdown, reclaimed the level');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('#review-marker-list li').first()).toContainText('MNQ');
  await expect(page.locator('#review-marker-list li').first()).toContainText('long');
  await expect(page.locator('#review-marker-list li').first()).toContainText('failed breakdown');

  // It survives a reload, i.e. it was actually persisted.
  await page.reload();
  await page.locator(`.session[data-session-id="${sessionId}"]`).click();
  await expect(page.locator('#review-marker-list li').first()).toContainText('MNQ');

  // ── add a marker by scrubbing, the fallback for anything missed live ──
  await page.evaluate(() => { document.getElementById('player').currentTime = 5; });
  await page.waitForFunction(() => !document.getElementById('player').seeking);
  await page.click('#btn-mark-here');

  await expect(page.locator('#review-marker-list li')).toHaveCount(2);
  // It opens straight into the editor so the detail can be typed immediately.
  await expect(page.locator('textarea[name="note"]')).toBeVisible();
  await page.fill('input[name="symbol"]', 'MES');
  await page.getByRole('button', { name: 'Save' }).click();

  const markers = await page.evaluate(async (id) => {
    const { getSession } = await import('/src/session-recorder.js');
    return (await getSession(id)).markers;
  }, sessionId);

  expect(markers).toHaveLength(2);
  expect(markers.map((m) => m.offsetMs)).toEqual([...markers.map((m) => m.offsetMs)].sort((a, b) => a - b));
  const added = markers.find((m) => m.addedDuringReview);
  expect(added.offsetMs).toBeGreaterThan(4500);
  expect(added.offsetMs).toBeLessThan(5500);
  expect(added.symbol).toBe('MES');

  // The join seam is present and empty — nothing infers a trade from this.
  for (const m of markers) {
    expect(m.externalTradeId).toBeNull();
    expect(m).not.toHaveProperty('pnl');
  }
});

test('deleting a session frees its space', async ({ page }) => {
  await page.goto('/');
  const sessionId = await recordShortSession(page, { seconds: 10 });

  const footprint = () => page.evaluate(async () => {
    const { recordingsFootprint } = await import('/src/session-recorder.js');
    return recordingsFootprint();
  });

  const stored = await page.evaluate(async (id) => {
    const { listChunkMeta, getSession } = await import('/src/session-recorder.js');
    const meta = await listChunkMeta(id);
    return { chunks: meta.length, bytes: (await getSession(id)).bytes };
  }, sessionId);

  expect(stored.chunks).toBeGreaterThan(3);
  expect(stored.bytes).toBeGreaterThan(10_000);

  const before = await footprint();
  expect(before.bytes).toBeGreaterThanOrEqual(stored.bytes);
  // The meter shows the recordings' own size, which is the number that moves.
  await expect(page.locator('#storage-text')).toContainText('1 session');

  // Delete from the review view, confirming the dialog.
  page.once('dialog', (d) => d.accept());
  await page.locator(`.session[data-session-id="${sessionId}"]`).click();
  await page.click('#btn-delete-session');

  await expect(page.locator(`.session[data-session-id="${sessionId}"]`)).toHaveCount(0);
  await expect(page.locator('#session-empty')).toBeVisible();

  // The chunks are gone, not just the row.
  const after = await page.evaluate(async (id) => {
    const { listChunkMeta, getSession, getSessionBlob } = await import('/src/session-recorder.js');
    return {
      chunks: (await listChunkMeta(id)).length,
      session: await getSession(id),
      blob: await getSessionBlob(id),
    };
  }, sessionId);

  expect(after.chunks).toBe(0);
  expect(after.session).toBeNull();
  expect(after.blob).toBeNull();

  // The space is measurably freed, and the meter says so immediately.
  const afterFootprint = await footprint();
  expect(afterFootprint.bytes).toBe(0);
  expect(afterFootprint.sessions).toBe(0);
  await expect(page.locator('#storage-text')).toContainText('0 sessions');

  // navigator.storage.estimate() is deliberately NOT asserted against here.
  // Chrome does not lower it for a long time after an IndexedDB delete — measured
  // flat for 12s after removing 255 KB — because compaction is deferred and the
  // figure is padded. That is why the meter reports our own total instead.
});

test('the UI states plainly that it computes no performance statistics', async ({ page }) => {
  await page.goto('/');
  const scope = page.locator('.notice-scope');
  await expect(scope).toContainText('review layer, not a statistics layer');
  await expect(scope).toContainText('no trade data source connected');

  // No performance number is shown anywhere, not even a placeholder zero.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/win rate\s*[:=]\s*\d/i);
  expect(body).not.toMatch(/P&L\s*[:=]/i);
  expect(body).not.toMatch(/profit factor\s*[:=]\s*\d/i);
});

test('the focus limitation is stated, not hidden', async ({ page }) => {
  await page.goto('/');
  const notice = page.locator('.notice-focus');
  await expect(notice).toContainText('Hotkeys only work while this tab is focused');

  await notice.locator('summary').click();
  await expect(notice).toContainText('browser extension');
  await expect(notice).toContainText('desktop wrapper');

  // The external marking entry point a wrapper would drive really is exposed.
  expect(await page.evaluate(() => typeof window.tradeJournal.mark)).toBe('function');
});
