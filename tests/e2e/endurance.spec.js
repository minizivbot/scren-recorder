/**
 * Definition of done #6: a long session must not exhaust memory.
 *
 * The property that actually matters is that chunks go to disk and are not
 * retained in the tab. If they were accumulating, heap would climb in step with
 * the bytes recorded — so this records continuously and compares heap growth
 * against the volume written, rather than trying to run for two real hours.
 */
import { test, expect, waitForRecording, stopAndSkipReview, gotoView } from './fixtures.js';

const RECORD_MS = 75_000;

test('heap stays flat while the recording grows', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');

  // Real charts are detailed; a flat synthetic canvas would compress to nearly
  // nothing and this test would prove nothing about volume.
  await page.evaluate(() => { window.__capture.noise = true; });

  // A high bitrate makes the data volume meaningful within the test's runtime.
  await gotoView(page, 'settings');
  await page.fill('#set-bitrate', '8000');
  await page.dispatchEvent('#set-bitrate', 'change');
  await gotoView(page, 'dashboard');

  await page.click('#btn-record');
  await waitForRecording(page);

  const heap = async () => page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  const bytesWritten = async () => page.evaluate(async () => {
    const { getSession } = await import('/src/session-recorder.js');
    const s = await getSession(window.tradeJournal.sessionId);
    return { bytes: s?.bytes ?? 0, chunks: s?.chunkCount ?? 0 };
  });

  // Let it settle before taking the baseline.
  await page.waitForTimeout(10_000);
  const baselineHeap = await heap();
  const baselineBytes = await bytesWritten();

  await page.waitForTimeout(RECORD_MS);

  const finalHeap = await heap();
  const finalBytes = await bytesWritten();

  const sessionId = await page.evaluate(() => window.tradeJournal.sessionId);
  await stopAndSkipReview(page);
  await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'idle');

  const grownBytes = finalBytes.bytes - baselineBytes.bytes;
  const grownHeap = finalHeap - baselineHeap;

  console.log(
    `recorded ${(grownBytes / 1e6).toFixed(1)} MB in ${finalBytes.chunks - baselineBytes.chunks} chunks; `
    + `heap ${(baselineHeap / 1e6).toFixed(1)} → ${(finalHeap / 1e6).toFixed(1)} MB`,
  );

  // The test is only meaningful if a real amount of video was written.
  expect(grownBytes).toBeGreaterThan(5_000_000);
  expect(finalBytes.chunks).toBeGreaterThan(30);

  // Heap must not track the data volume. A recorder buffering chunks in memory
  // would show growth of the same order as grownBytes.
  expect(grownHeap).toBeLessThan(grownBytes * 0.25);
  // And in absolute terms it should barely move at all.
  expect(grownHeap).toBeLessThan(25_000_000);

  // Extrapolate honestly: at this rate, what would two hours cost on disk?
  const bytesPerMs = grownBytes / RECORD_MS;
  const twoHours = bytesPerMs * 2 * 60 * 60 * 1000;
  console.log(`extrapolated two-hour size at this bitrate: ${(twoHours / 1e9).toFixed(2)} GB`);

  // And the session is still intact after all that.
  const session = await page.evaluate(async (id) => {
    const { getSession, listChunkMeta } = await import('/src/session-recorder.js');
    const s = await getSession(id);
    const meta = await listChunkMeta(id);
    return { status: s.status, chunkCount: s.chunkCount, stored: meta.length, seqs: meta.map((c) => c.seq) };
  }, sessionId);

  expect(session.status).toBe('complete');
  expect(session.stored).toBe(session.chunkCount);
  // Every sequence number present exactly once, in order.
  expect(session.seqs).toEqual([...Array(session.stored).keys()]);
});
