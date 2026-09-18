/**
 * The journal: what happens after you stop recording, and whether the numbers
 * that come out the other end are the ones you entered.
 */
import { test, expect, waitForRecording } from './fixtures.js';

async function recordBriefly(page, seconds = 4) {
  await page.click('#btn-record');
  await waitForRecording(page);
  await page.locator('body').press('e');
  await page.waitForTimeout(seconds * 1000);
  await page.click('#btn-record');
}

test('stopping a session asks how the day went, then for the trades', async ({ page }) => {
  await page.goto('/');
  await recordBriefly(page);

  // ── step 1: the day ───────────────────────────────────────────────────
  await expect(page.locator('.wizard')).toBeVisible();
  await expect(page.locator('.wizard-head h2')).toHaveText('How was your day?');

  await page.locator('.star-btn').nth(3).click(); // 4 stars
  await expect(page.locator('.rating-label')).toHaveText('Good');
  await page.fill('#day-note', 'Patient early, forced the last one.');
  await page.click('#wizard-next');

  // ── step 2: were there trades ─────────────────────────────────────────
  await expect(page.locator('.wizard-head h2')).toHaveText('Did you take any trades?');
  await page.click('#took-trades');

  // ── step 3: the details ───────────────────────────────────────────────
  await expect(page.locator('.trade-form')).toBeVisible();
  await page.fill('input[name="symbol"]', 'mnq');
  await page.selectOption('select[name="direction"]', 'short');
  await page.fill('input[name="r"]', '2.5');
  await page.locator('.tag-btn', { hasText: 'FVG' }).click();
  await page.fill('#trade-note', 'swept the high then rejected');
  await page.getByRole('button', { name: 'Save trade' }).click();

  // ── it offers another, then finishes ──────────────────────────────────
  await expect(page.locator('.wizard-head h2')).toHaveText('Trade saved');
  await page.click('#add-another');

  await page.fill('input[name="symbol"]', 'MES');
  await page.fill('input[name="r"]', '-1');
  await page.getByRole('button', { name: 'Save trade' }).click();
  await page.click('#wizard-finish');

  await expect(page.locator('.wizard')).toHaveCount(0);

  // ── the record is what was typed, nothing inferred ────────────────────
  const trades = await page.evaluate(async () => {
    const { listTrades } = await import('/src/trades.js');
    return listTrades();
  });

  expect(trades).toHaveLength(2);
  const mnq = trades.find((t) => t.symbol === 'MNQ');
  expect(mnq).toMatchObject({
    symbol: 'MNQ', direction: 'short', r: 2.5, outcome: 'win', note: 'swept the high then rejected',
  });
  expect(mnq.pois).toEqual(['FVG']);
  // Linked to the recording so you can jump to the footage, not derived from it.
  expect(mnq.sessionId).toMatch(/^sess_/);

  const mes = trades.find((t) => t.symbol === 'MES');
  expect(mes).toMatchObject({ r: -1, outcome: 'loss' });

  // ── the dashboard reflects it ─────────────────────────────────────────
  await page.click('[data-view="dashboard"]');
  const tiles = page.locator('.stat-tile');
  await expect(tiles.filter({ hasText: 'Net R' })).toContainText('+1.50R');
  await expect(tiles.filter({ hasText: 'Win rate' })).toContainText('50%');
  await expect(page.locator('.stat-note')).toContainText('From your own entries');

  // ── and the journal shows the day, its rating and its note ────────────
  await page.click('[data-view="journal"]');
  const day = page.locator('.journal-day').first();
  await expect(day).toContainText('+1.50R');
  await expect(day).toContainText('Patient early, forced the last one.');
  await expect(day.locator('.star.is-on')).toHaveCount(4);
  await expect(day.locator('.journal-trade')).toHaveCount(2);
  // A day with a recording links to it.
  await expect(day.locator('.journal-sessions button')).toHaveCount(1);
});

test('a day with no trades is still a journal entry', async ({ page }) => {
  await page.goto('/');
  await recordBriefly(page);

  await page.locator('.star-btn').nth(1).click(); // 2 stars
  await page.fill('#day-note', 'Nothing set up. Sat on my hands.');
  await page.click('#wizard-next');
  await page.click('#no-trades');

  await expect(page.locator('.wizard')).toHaveCount(0);

  await page.click('[data-view="journal"]');
  const day = page.locator('.journal-day').first();
  // "Sat on my hands" is a real entry, not an absence.
  await expect(day).toContainText('Recorded, no trades taken');
  await expect(day).toContainText('Nothing set up.');
  await expect(day.locator('.star.is-on')).toHaveCount(2);

  // And the dashboard still says it has no trades, rather than showing zeros.
  await page.click('[data-view="dashboard"]');
  await expect(page.locator('.stat-empty')).toContainText('No trades logged yet');
  await expect(page.locator('.stat-tile')).toHaveCount(0);
});

test('the whole review can be skipped', async ({ page }) => {
  await page.goto('/');
  await recordBriefly(page);

  // A journal you cannot skip is one you stop opening.
  await expect(page.locator('.wizard')).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.wizard')).toHaveCount(0);

  const trades = await page.evaluate(async () => {
    const { listTrades } = await import('/src/trades.js');
    return listTrades();
  });
  expect(trades).toHaveLength(0);

  // The recording is still there — skipping the review costs nothing.
  await page.click('[data-view="recordings"]');
  await expect(page.locator('.session')).toHaveCount(1);
});

test('trades can be added, edited and deleted without a recording', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-view="trades"]');
  await expect(page.locator('#trades-empty')).toBeVisible();

  await page.click('#btn-add-trade');
  await page.fill('input[name="symbol"]', 'MNQ');
  await page.fill('input[name="r"]', '3');
  await page.getByRole('button', { name: 'Save trade' }).click();
  await page.click('#wizard-finish');

  await expect(page.locator('#trades-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.cell-r').first()).toHaveText('+3.00R');

  // Edit it down to a loss and check the row follows.
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.fill('input[name="r"]', '-1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.cell-r').first()).toHaveText('-1.00R');

  const trade = await page.evaluate(async () => {
    const { listTrades } = await import('/src/trades.js');
    return (await listTrades())[0];
  });
  expect(trade.outcome).toBe('loss');
  // Logged without a session: a trade does not require a recording.
  expect(trade.sessionId).toBeNull();

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await expect(page.locator('#trades-empty')).toBeVisible();
});

test('the trader defines their own setups', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-view="settings"]');

  await expect(page.locator('#poi-tags .tag')).not.toHaveCount(0);

  await page.fill('#poi-input', 'Session open drive');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#poi-tags')).toContainText('Session open drive');

  // Remove one of the seeded ones.
  const fvg = page.locator('.tag-removable', { hasText: 'FVG' });
  await fvg.locator('.tag-x').click();
  await expect(page.locator('#poi-tags')).not.toContainText('FVG');

  // The trade form offers exactly what is in the list.
  await page.click('[data-view="trades"]');
  await page.click('#btn-add-trade');
  await expect(page.locator('.poi-row')).toContainText('Session open drive');
  await expect(page.locator('.poi-row')).not.toContainText('FVG');

  // It survives a reload.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await page.click('[data-view="settings"]');
  await expect(page.locator('#poi-tags')).toContainText('Session open drive');
});

test('statistics come only from trades, never from recordings or markers', async ({ page }) => {
  await page.goto('/');

  // Record with markers, but log no trades.
  await page.click('#btn-record');
  await waitForRecording(page);
  await page.locator('body').press('e');
  await page.waitForTimeout(1500);
  await page.locator('body').press('x');
  await page.waitForTimeout(2000);
  await page.click('#btn-record');

  await page.getByRole('button', { name: 'Skip' }).click();

  // Two markers exist. They must not have produced a single statistic: a
  // marker says "something happened here", not what it was worth.
  const markers = await page.evaluate(async () => {
    const { listSessions } = await import('/src/session-recorder.js');
    return (await listSessions())[0].markers;
  });
  expect(markers).toHaveLength(2);

  await page.click('[data-view="dashboard"]');
  await expect(page.locator('.stat-empty')).toContainText('No trades logged yet');
  await expect(page.locator('.stat-empty')).toContainText('nothing is inferred from a recording');

  const body = await page.locator('#view-dashboard').innerText();
  expect(body).not.toMatch(/\d+(\.\d+)?R/); // no R figure anywhere
  expect(body).not.toMatch(/\d+%/);         // no win rate
});
