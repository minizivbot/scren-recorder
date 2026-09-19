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
  await page.locator('.outcome-btn[data-outcome="win"]').click();
  await page.fill('input[name="symbol"]', 'mnq');
  await page.selectOption('select[name="direction"]', 'short');
  await page.fill('input[name="r"]', '2.5');
  await page.fill('input[name="pnl"]', '500');
  await page.locator('.tag-btn', { hasText: 'FVG' }).click();
  await page.fill('#trade-note', 'swept the high then rejected');
  await page.getByRole('button', { name: 'Save trade' }).click();

  // ── it offers another, then finishes ──────────────────────────────────
  await expect(page.locator('.wizard-head h2')).toHaveText('Trade saved');
  await page.click('#add-another');

  // A loss is chosen, and the plain positive number typed below becomes
  // negative on its own.
  await page.locator('.outcome-btn[data-outcome="loss"]').click();
  await page.fill('input[name="symbol"]', 'MES');
  await page.fill('input[name="r"]', '1');
  await page.fill('input[name="pnl"]', '200');
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
    symbol: 'MNQ', direction: 'short', r: 2.5, pnl: 500, outcome: 'win',
    note: 'swept the high then rejected',
  });
  expect(mnq.pois).toEqual(['FVG']);
  // Linked to the recording so you can jump to the footage, not derived from it.
  expect(mnq.sessionId).toMatch(/^sess_/);

  const mes = trades.find((t) => t.symbol === 'MES');
  // Typed as 1 and 200, stored as a loss without anyone typing a minus sign.
  expect(mes).toMatchObject({ r: -1, pnl: -200, outcome: 'loss' });

  // ── the dashboard reflects it ─────────────────────────────────────────
  await page.click('[data-view="dashboard"]');
  // Matched on the tile's own label: the expectancy explainer text mentions
  // "win rate" too, and a loose filter picks up both tiles.
  const tile = (label) => page.locator('.stat-tile')
    .filter({ has: page.locator('.stat-tile-label > span', { hasText: new RegExp(`^${label}$`) }) });

  await expect(tile('Net R')).toContainText('+1.50R');
  await expect(tile('Net P&L')).toContainText('+\$300');
  await expect(tile('Win rate')).toContainText('50%');
  await expect(page.locator('.stat-note')).toContainText('From your own entries');

  // ── and the journal shows the day, its rating and its note ────────────
  await page.click('[data-view="journal"]');
  const day = page.locator('.journal-day').first();
  await expect(day).toContainText('+$300');
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
  await page.fill('input[name="pnl"]', '600');
  await page.getByRole('button', { name: 'Save trade' }).click();
  await page.click('#wizard-finish');

  await expect(page.locator('#trades-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.cell-r').first()).toHaveText('+3.00R');

  // Switch it to a loss and check both amounts follow, without retyping them.
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.locator('.outcome-btn[data-outcome="loss"]').click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.cell-r').first()).toHaveText('-3.00R');

  const trade = await page.evaluate(async () => {
    const { listTrades } = await import('/src/trades.js');
    return (await listTrades())[0];
  });
  expect(trade.outcome).toBe('loss');
  expect(trade.r).toBe(-3);
  expect(trade.pnl).toBe(-600);
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
  expect(body).not.toMatch(/\$\d/);          // no money either
  expect(body).not.toMatch(/\d+%/);          // no win rate
});

test('the journal note buttons actually do something', async ({ page }) => {
  // Regression: these were wired to window.prompt(), which Electron does not
  // implement — it returns null without showing anything, so the button did
  // nothing at all in the desktop app and there was no error to notice.
  await page.goto('/');
  await page.click('[data-view="trades"]');
  await page.click('#btn-add-trade');
  await page.fill('input[name="r"]', '1');
  await page.getByRole('button', { name: 'Save trade' }).click();
  await page.click('#wizard-finish');

  await page.click('[data-view="journal"]');
  // The journal opens on the calendar now; the note buttons live in the list.
  await page.locator('.mode-btn[data-mode="list"]').click();
  await page.getByRole('button', { name: 'Add note' }).first().click();

  // A real dialog, in the page, not a native prompt.
  await expect(page.locator('.wizard')).toBeVisible();
  await expect(page.locator('.wizard-head h2')).toHaveText('How was this day?');

  await page.locator('.star-btn').nth(2).click();
  await page.fill('#day-note', 'Read it right, sized it wrong.');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.wizard')).toHaveCount(0);
  const day = page.locator('.journal-day').first();
  await expect(day).toContainText('Read it right, sized it wrong.');
  await expect(day.locator('.star.is-on')).toHaveCount(3);

  // And editing it back reopens with what was written.
  await page.getByRole('button', { name: 'Edit note' }).first().click();
  await expect(page.locator('#day-note')).toHaveValue('Read it right, sized it wrong.');
  await expect(page.locator('.star-btn.is-on')).toHaveCount(3);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.wizard')).toHaveCount(0);
});

test('a breakeven can still carry an R and a P&L', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-view="trades"]');
  await page.click('#btn-add-trade');

  // Scratching a trade rarely costs exactly nothing — commissions come off.
  await page.locator('.outcome-btn[data-outcome="breakeven"]').click();
  await expect(page.locator('input[name="r"]')).toBeVisible();
  await expect(page.locator('input[name="pnl"]')).toBeVisible();
  await expect(page.locator('#amount-note')).toContainText('minus in front for commissions');

  await page.fill('input[name="symbol"]', 'MES');
  await page.fill('input[name="r"]', '0.1');
  await page.fill('input[name="pnl"]', '-14');
  await page.getByRole('button', { name: 'Save trade' }).click();
  await page.click('#wizard-finish');

  const trade = await page.evaluate(async () => {
    const { listTrades } = await import('/src/trades.js');
    return (await listTrades())[0];
  });

  // Kept as entered rather than flattened to zero.
  expect(trade).toMatchObject({ outcome: 'breakeven', r: 0.1, pnl: -14 });

  // Still out of the win rate — it is a classification, not a sign test.
  await page.click('[data-view="dashboard"]');
  const tile = (label) => page.locator('.stat-tile')
    .filter({ has: page.locator('.stat-tile-label > span', { hasText: new RegExp(`^${label}$`) }) });
  await expect(tile('Win rate')).toContainText('—');
  await expect(tile('Net P&L')).toContainText('-$14');
});

test('the amount field is labelled P&L', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-view="trades"]');
  await page.click('#btn-add-trade');
  await expect(page.locator('.field-grid.amounts')).toContainText('P&L');
  await expect(page.locator('.field-grid.amounts')).toContainText('Risk multiple (R)');
});

test('the month calendar colours each day by its result and shows the amount', async ({ page }) => {
  await page.goto('/');

  // Seed three days directly: a winner, a loser, and a day that was recorded
  // but never logged. Going through the UI would put them all on today.
  await page.evaluate(async () => {
    const { saveTrade } = await import('/src/trades.js');
    const now = new Date();
    const on = (dayOfMonth) =>
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;

    await saveTrade({ symbol: 'MNQ', direction: 'long', outcome: 'win', r: 3, pnl: 600, date: on(3) });
    await saveTrade({ symbol: 'MES', direction: 'short', outcome: 'loss', r: -1, pnl: -250, date: on(4) });
    // Two on one day, netting negative: the box follows the day, not a trade.
    await saveTrade({ symbol: 'MNQ', direction: 'long', outcome: 'win', r: 1, pnl: 100, date: on(5) });
    await saveTrade({ symbol: 'MNQ', direction: 'long', outcome: 'loss', r: -2, pnl: -400, date: on(5) });
  });

  await page.click('[data-view="journal"]');
  await expect(page.locator('#journal-calendar')).toBeVisible();

  const dayBox = (n) => {
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    return page.locator(`.cal-day[data-date="${key}"]`);
  };

  await expect(dayBox(3)).toHaveAttribute('data-tone', 'win');
  await expect(dayBox(3).locator('.cal-amount')).toHaveText('+$600');

  await expect(dayBox(4)).toHaveAttribute('data-tone', 'loss');
  await expect(dayBox(4).locator('.cal-amount')).toHaveText('-$250');

  // Net of +100 and -400 is a red day, even though one of the two trades won.
  await expect(dayBox(5)).toHaveAttribute('data-tone', 'loss');
  await expect(dayBox(5).locator('.cal-amount')).toHaveText('-$300');

  // A day with nothing entered gets no colour and no number invented for it.
  await expect(dayBox(28)).toHaveAttribute('data-tone', 'none');
  await expect(dayBox(28).locator('.cal-amount')).toHaveCount(0);

  // The month total is the sum of those days and nothing else:
  // +600 - 250 - 300 = +50.
  await expect(page.locator('.cal-total').first()).toHaveText('+$50');
});

test('the calendar walks through months and back to today', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-view="journal"]');

  const label = page.locator('#cal-label');
  const start = await label.textContent();

  await page.click('#cal-prev');
  await expect(label).not.toHaveText(start);
  const previous = await label.textContent();

  await page.click('#cal-next');
  await expect(label).toHaveText(start);

  // Far enough to cross a year boundary, then straight home.
  for (let i = 0; i < 14; i += 1) await page.click('#cal-prev');
  await expect(label).not.toHaveText(previous);
  await page.click('#cal-today');
  await expect(label).toHaveText(start);

  // Every row is a full week, whatever month we land on.
  const cells = await page.locator('.cal-day').count();
  expect(cells % 7).toBe(0);
});

test('clicking a day opens that day, and the list view still works', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-view="journal"]');

  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-07`;
  await page.locator(`.cal-day[data-date="${key}"]`).click();

  // The same rating-and-note step the end-of-session review opens with.
  await expect(page.locator('.wizard')).toBeVisible();
  await expect(page.locator('.wizard-head h2')).toHaveText('How was this day?');
  await page.locator('.star-btn').nth(3).click();
  await page.fill('#day-note', 'Chose this day from the calendar.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.wizard')).toHaveCount(0);

  const saved = await page.evaluate(async (date) => {
    const { getDayReview } = await import('/src/trades.js');
    return getDayReview(date);
  }, key);
  expect(saved.rating).toBe(4);
  expect(saved.note).toContain('calendar');

  await page.locator('.mode-btn[data-mode="list"]').click();
  await expect(page.locator('#journal-list')).toBeVisible();
  await expect(page.locator('#journal-calendar')).toBeHidden();

  await page.locator('.mode-btn[data-mode="calendar"]').click();
  await expect(page.locator('#journal-calendar')).toBeVisible();
});
