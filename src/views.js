/**
 * Dashboard, journal and trades pages.
 *
 * Every number here comes from entered trades. When there are none, the page
 * says so — it does not show a zero, because an unknown win rate and a 0% win
 * rate look identical on screen and mean opposite things.
 */
import {
  computeStats, byDay, byPoi, maxDrawdown, streaks, recent,
  formatR, formatMoney, formatPercent,
} from './stats.js';
import { listTrades, buildJournal, deleteTrade } from './trades.js';
import { $, el, clear, formatDate } from './dom.js';
import { formatDuration } from './dom.js';

export const RANGES = [
  { id: '7', label: '7 days', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: 'all', label: 'All', days: null },
];

/** Signed class for colouring an R value. */
function rClass(r) {
  if (r == null || r === 0) return 'flat';
  return r > 0 ? 'up' : 'down';
}

// ─────────────────────────── dashboard ───────────────────────────

export async function renderDashboard({ rangeId = '30', onRangeChange } = {}) {
  const all = await listTrades();
  const range = RANGES.find((r) => r.id === rangeId) || RANGES[1];
  const trades = range.days ? recent(all, range.days) : all;

  renderRangeTabs(rangeId, onRangeChange);

  const stats = computeStats(trades);
  const grid = clear($('#stat-grid'));

  if (!stats.hasData) {
    grid.append(el('div', { class: 'stat-empty' },
      el('strong', {}, 'No trades logged yet.'),
      el('p', {},
        'Statistics appear once you log a trade. They are computed only from what you enter — '
        + 'nothing is inferred from a recording or from a marker, because a video is not a '
        + 'queryable record of what you traded.'),
    ));
    await renderRecentDays(all);
    return;
  }

  const dd = maxDrawdown(trades);
  const streak = streaks(trades);
  const hasMoney = trades.some((t) => t.pnl);

  // The headline pair: what it did to the account, and whether the decisions
  // were any good. They answer different questions and both belong up front.
  grid.append(
    hero('Net P&L', hasMoney ? formatMoney(stats.totalPnl) : '—',
      rClass(stats.totalPnl),
      hasMoney ? `across ${stats.trades} trade${stats.trades === 1 ? '' : 's'}`
        : 'no amounts entered yet'),
    hero('Net R', formatR(stats.totalR), rClass(stats.totalR),
      `${stats.wins}W · ${stats.losses}L${stats.breakeven ? ` · ${stats.breakeven}BE` : ''}`),
  );

  grid.append(
    tile('Win rate', formatPercent(stats.winRate), 'flat',
      stats.breakeven ? `${stats.breakeven} scratched, not counted` : 'of decided trades'),

    tile('Expectancy', formatR(stats.expectancy), rClass(stats.expectancy),
      hasMoney ? `${formatMoney(stats.expectancyPnl)} per trade` : 'per trade',
      // The number that actually decides whether a strategy makes money.
      'What one more trade is worth on this record. A 70% win rate with '
      + 'negative expectancy still loses money.'),

    tile('Profit factor', stats.profitFactor ?? '—',
      rClass((stats.profitFactor ?? 1) - 1),
      stats.profitFactor == null ? 'no losses yet' : 'won ÷ lost',
      'Gross winnings divided by gross losses. Above 1 means the wins outweigh '
      + 'the losses.'),

    // Win and loss sit together: the ratio between them is the point, and
    // neither number says much read on its own.
    pairTile('Win / loss',
      hasMoney ? formatMoney(stats.avgWinPnl) : formatR(stats.avgWin),
      hasMoney ? formatMoney(stats.avgLossPnl == null ? null : -stats.avgLossPnl)
        : (stats.avgLoss == null ? '—' : `-${stats.avgLoss.toFixed(2)}R`),
      stats.avgWin != null && stats.avgLoss
        ? `${round1(stats.avgWin / stats.avgLoss)} : 1` : 'no pair yet'),

    tile('Drawdown',
      dd == null ? '—' : (hasMoney ? formatMoney(-dd.pnl) : formatR(-dd.r)),
      dd && (hasMoney ? dd.pnl : dd.r) > 0 ? 'down' : 'flat',
      dd == null ? '' : (hasMoney ? formatR(-dd.r) : 'peak to trough'),
      'The deepest fall from a high point to the low that followed it — how bad '
      + 'the worst stretch got.'),

    tile('Streak', streak.kind ? `${streak.current} ${streak.kind === 'win' ? 'W' : 'L'}` : '—',
      streak.kind === 'win' ? 'up' : streak.kind === 'loss' ? 'down' : 'flat',
      `longest ${streak.longestWin}W / ${streak.longestLoss}L`),
  );

  grid.append(el('p', { class: 'stat-note' },
    'From your own entries, not a broker statement.'));

  await renderRecentDays(all);
}

/** Two numbers that only mean something next to each other. */
function pairTile(label, up, down, sub) {
  return el('div', { class: 'stat-tile stat-pair' },
    el('span', { class: 'stat-tile-label' }, el('span', {}, label)),
    el('span', { class: 'stat-pair-values' },
      el('span', { class: 'pair-up' }, String(up)),
      el('span', { class: 'pair-sep' }, '/'),
      el('span', { class: 'pair-down' }, String(down)),
    ),
    sub ? el('span', { class: 'stat-tile-sub' }, sub) : null,
  );
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** A large tile for the two numbers that matter most. */
function hero(label, value, tone, sub) {
  return el('div', { class: 'stat-tile stat-hero', dataset: { tone } },
    el('span', { class: 'stat-tile-label' }, el('span', {}, label)),
    el('span', { class: 'stat-tile-value' }, String(value)),
    sub ? el('span', { class: 'stat-tile-sub' }, sub) : null,
  );
}

/**
 * `explain` turns the label into something you can hover or tap.
 * A dashboard full of terms nobody defined is a dashboard nobody reads.
 */
function tile(label, value, tone, sub, explain) {
  return el('div', { class: 'stat-tile', dataset: { tone } },
    el('span', { class: 'stat-tile-label' }, el('span', {}, label),
      explain ? el('button', {
        class: 'explain', type: 'button', title: explain, 'aria-label': `What is ${label}?`,
        onclick: (e) => {
          e.currentTarget.closest('.stat-tile').classList.toggle('is-explained');
        },
      }, '?') : null),
    el('span', { class: 'stat-tile-value' }, String(value)),
    sub ? el('span', { class: 'stat-tile-sub' }, sub) : null,
    explain ? el('p', { class: 'stat-explain' }, explain) : null,
  );
}

function renderRangeTabs(active, onChange) {
  const tabs = clear($('#range-tabs'));
  for (const range of RANGES) {
    tabs.append(el('button', {
      class: `range-tab${range.id === active ? ' is-active' : ''}`,
      type: 'button',
      onclick: () => onChange?.(range.id),
    }, range.label));
  }
}

async function renderRecentDays(allTrades) {
  const days = byDay(allTrades).slice(0, 7);
  const host = clear($('#recent-days'));

  if (!days.length) {
    host.append(el('p', { class: 'empty' }, 'No trading days yet.'));
    return;
  }

  const anyMoney = days.some((d) => d.pnl);

  host.append(el('div', { class: 'day-strip' },
    ...days.map((d) => el('div', { class: 'day-chip', dataset: { tone: rClass(d.r) } },
      el('span', { class: 'day-chip-date' }, shortDate(d.date)),
      el('span', { class: 'day-chip-r' }, anyMoney ? formatMoney(d.pnl) : formatR(d.r)),
      el('span', { class: 'day-chip-sub' },
        anyMoney ? `${formatR(d.r)} · ${d.trades}` : `${d.trades} trade${d.trades === 1 ? '' : 's'}`),
    )),
  ));
}

// ─────────────────────────── journal ───────────────────────────

export async function renderJournal({ onOpenSession, onEditDay } = {}) {
  const days = await buildJournal();
  $('#journal-count').textContent = String(days.length);
  $('#journal-empty').hidden = days.length > 0;

  const list = clear($('#journal-list'));

  for (const day of days) {
    const hasTrades = day.trades.length > 0;

    list.append(el('article', { class: 'journal-day' },
      el('div', { class: 'journal-day-head' },
        el('div', {},
          el('h3', {}, longDate(day.date)),
          el('span', { class: 'muted' },
            hasTrades
              ? `${day.trades.length} trade${day.trades.length === 1 ? '' : 's'} · ${day.wins}W ${day.losses}L`
              // A day you recorded and took nothing is a real journal entry.
              : day.sessions.length ? 'Recorded, no trades taken' : 'No trades'),
        ),
        el('div', { class: 'journal-day-right' },
          hasTrades ? el('span', { class: 'day-totals' },
            day.pnl ? el('span', { class: 'day-r', dataset: { tone: rClass(day.pnl) } }, formatMoney(day.pnl)) : null,
            el('span', { class: day.pnl ? 'day-sub-r' : 'day-r', dataset: { tone: rClass(day.r) } }, formatR(day.r)),
          ) : null,
          day.review ? stars(day.review.rating) : null,
          el('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: () => onEditDay?.(day),
          }, day.review ? 'Edit note' : 'Add note'),
        ),
      ),

      day.review?.note ? el('p', { class: 'journal-note' }, day.review.note) : null,

      hasTrades ? el('ul', { class: 'journal-trades' },
        ...day.trades.map((t) => el('li', { class: 'journal-trade', dataset: { outcome: t.outcome } },
          el('span', { class: 'jt-sym' }, t.symbol || '—'),
          el('span', { class: 'jt-dir muted' }, t.direction),
          el('span', { class: 'jt-r', dataset: { tone: rClass(t.r) } }, formatR(t.r)),
          t.pnl ? el('span', { class: 'jt-pnl', dataset: { tone: rClass(t.pnl) } }, formatMoney(t.pnl)) : null,
          t.pois.length ? el('span', { class: 'jt-pois' }, ...t.pois.map((p) => el('span', { class: 'tag' }, p))) : null,
          t.note ? el('span', { class: 'jt-note muted' }, t.note) : null,
        )),
      ) : null,

      day.sessions.length ? el('div', { class: 'journal-sessions' },
        ...day.sessions.map((s) => el('button', {
          class: 'btn btn-ghost btn-small', type: 'button',
          onclick: () => onOpenSession?.(s.id),
        }, `▶ Recording · ${formatDuration(s.durationMs || 0)}`)),
      ) : null,
    ));
  }
}

function stars(rating) {
  return el('span', { class: 'stars', title: `${rating} of 5` },
    ...[1, 2, 3, 4, 5].map((n) => el('span', {
      class: `star${n <= rating ? ' is-on' : ''}`,
    }, '★')),
  );
}

// ─────────────────────────── trades ───────────────────────────

export async function renderTrades({ onEdit, onChanged } = {}) {
  const trades = await listTrades();
  $('#trades-count').textContent = String(trades.length);
  $('#trades-empty').hidden = trades.length > 0;

  const table = clear($('#trades-table'));
  if (trades.length) {
    table.append(
      el('thead', {}, el('tr', {},
        ...['Date', 'Symbol', 'Side', 'R', 'P&L', 'Setups', 'Note', ''].map((h) => el('th', {}, h)),
      )),
      el('tbody', {},
        ...trades.map((t) => el('tr', { dataset: { outcome: t.outcome } },
          el('td', {}, shortDate(t.date)),
          el('td', { class: 'cell-sym' }, t.symbol || '—'),
          el('td', { class: 'muted' }, t.direction),
          el('td', { class: 'cell-r', dataset: { tone: rClass(t.r) } }, formatR(t.r)),
          el('td', { class: 'cell-r', dataset: { tone: rClass(t.pnl) } },
            t.pnl ? formatMoney(t.pnl) : '—'),
          el('td', {}, ...(t.pois || []).map((p) => el('span', { class: 'tag' }, p))),
          el('td', { class: 'cell-note muted' }, t.note || ''),
          el('td', { class: 'cell-actions' },
            el('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => onEdit?.(t) }, 'Edit'),
            el('button', {
              class: 'btn btn-ghost btn-small btn-danger', type: 'button',
              onclick: async () => {
                if (!window.confirm(`Delete the ${t.symbol || ''} trade on ${shortDate(t.date)}?`)) return;
                await deleteTrade(t.id);
                onChanged?.();
              },
            }, 'Delete'),
          ),
        )),
      ),
    );
  }

  renderPoiTable(trades);
}

function renderPoiTable(trades) {
  const rows = byPoi(trades);
  $('#poi-empty').hidden = rows.length > 0;

  const table = clear($('#poi-table'));
  if (!rows.length) return;

  table.append(
    el('thead', {}, el('tr', {},
      ...['Setup', 'Trades', 'Net R', 'Net P&L', 'Win rate', 'Expectancy'].map((h) => el('th', {}, h)),
    )),
    el('tbody', {},
      ...rows.map((row) => el('tr', {},
        el('td', {}, el('span', { class: 'tag' }, row.poi)),
        // The count is never far from the verdict: three trades is not evidence.
        el('td', { class: row.trades < 5 ? 'muted' : '' },
          row.trades < 5 ? `${row.trades} — too few to judge` : String(row.trades)),
        el('td', { class: 'cell-r', dataset: { tone: rClass(row.totalR) } }, formatR(row.totalR)),
        el('td', { class: 'cell-r', dataset: { tone: rClass(row.totalPnl) } },
          row.totalPnl ? formatMoney(row.totalPnl) : '—'),
        el('td', {}, formatPercent(row.winRate)),
        el('td', { class: 'cell-r', dataset: { tone: rClass(row.expectancy) } }, formatR(row.expectancy)),
      )),
    ),
  );
}

// ─────────────────────────── dates ───────────────────────────

function shortDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function longDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

export { shortDate, longDate, rClass };
