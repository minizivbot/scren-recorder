/**
 * The point of the bridge: a marker dropped from outside the browser, while the
 * recorder tab is not the focused thing on screen.
 *
 * The request is made from Node, not from the page, so it genuinely travels the
 * path a hotkey tool would use.
 */
import { test, expect, waitForRecording } from './fixtures.js';

const BASE = 'http://localhost:5173';

/** Posts a command exactly the way the AutoHotkey script does. */
async function sendCommand(body) {
  const res = await fetch(`${BASE}/bridge/mark`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('an external hotkey marks a live recording while the tab is unfocused', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#bridge-state')).toHaveAttribute('data-connected', 'true');
  await expect(page.locator('#bridge-label')).toHaveText('Global hotkeys: ready');

  await page.click('#btn-record');
  await waitForRecording(page);

  // Take focus away from the recorder, the way clicking into Tradovate would.
  // An in-page keydown listener receives nothing from here on.
  const other = await page.context().newPage();
  await other.goto('about:blank');
  await other.bringToFront();

  // Confirm the premise: a keypress delivered elsewhere does not reach the app.
  await other.keyboard.press('e');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.tradeJournal.markers.length)).toBe(0);

  // Now the hotkey tool's route.
  const entry = await sendCommand({ command: 'mark', kind: 'entry', direction: 'long', symbol: 'MNQ' });
  expect(entry.status).toBe(200);
  expect(entry.body.delivered).toBe(1);

  await page.waitForFunction(() => window.tradeJournal.markers.length === 1);
  await page.waitForTimeout(3000);

  const exit = await sendCommand({ command: 'mark', kind: 'exit', symbol: 'MNQ' });
  expect(exit.body.delivered).toBe(1);
  await page.waitForFunction(() => window.tradeJournal.markers.length === 2);

  const markers = await page.evaluate(() => window.tradeJournal.markers);
  expect(markers[0]).toMatchObject({ kind: 'entry', direction: 'long', symbol: 'MNQ', source: 'hotkey' });
  expect(markers[1]).toMatchObject({ kind: 'exit', symbol: 'MNQ' });
  // Offsets are real time into the recording, same as an in-page mark.
  expect(markers[1].offsetMs - markers[0].offsetMs).toBeGreaterThan(2500);

  // The live list updated even though the tab never regained focus.
  await expect(page.locator('#live-marker-list li')).toHaveCount(2);
  await other.close();

  // Stopping remotely works too.
  const sessionId = await page.evaluate(() => window.tradeJournal.sessionId);
  const stopped = await sendCommand({ command: 'stop' });
  expect(stopped.body.delivered).toBe(1);

  await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'idle');

  const session = await page.evaluate(async (id) => {
    const { getSession } = await import('/src/session-recorder.js');
    return getSession(id);
  }, sessionId);

  expect(session.status).toBe('complete');
  expect(session.markers).toHaveLength(2);
  expect(session.markers[0].symbol).toBe('MNQ');
});

test('says so when a hotkey fires with nothing recording', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#bridge-state')).toHaveAttribute('data-connected', 'true');

  // A silent no-op here is the worst case: you would think you had marked it.
  const result = await sendCommand({ command: 'mark', kind: 'entry' });
  expect(result.body.delivered).toBe(1);

  await expect(page.locator('#alert-banner')).toContainText('nothing is recording');
});

test('reports when no tab is listening, rather than appearing to succeed', async () => {
  // With no page open, the hotkey tool must be able to tell the difference.
  const result = await sendCommand({ command: 'mark', kind: 'entry' });
  expect(result.status).toBe(200);
  expect(result.body.delivered).toBe(0);
});

test('refuses commands that did not come from a local tool', async () => {
  // A site you happen to be visiting must not be able to inject markers.
  const withOrigin = await fetch(`${BASE}/bridge/mark`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ kind: 'entry' }),
  });
  expect(withOrigin.status).toBe(403);

  const formPost = await fetch(`${BASE}/bridge/mark`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'kind=entry',
  });
  expect(formPost.status).toBe(415);

  // And the event stream carries no CORS headers, so no other origin can read it.
  const stream = await fetch(`${BASE}/bridge/status`);
  expect(stream.headers.get('access-control-allow-origin')).toBeNull();
});
