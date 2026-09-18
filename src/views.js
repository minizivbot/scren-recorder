/**
 * Dashboard, journal and trades pages.
 *
 * Every number here comes from entered trades. When there are none, the page
 * says so — it does not show a zero, because an unknown win rate and a 0% win
 * rate look identical on screen and mean opposite things.
 */
import {
  computeStats, byDay, byPoi, maxDrawdown, streaks, recent, formatR, formatPercent,
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

  grid.append(
    tile('Net R', formatR(stats.totalR), rClass(stats.totalR), `${stats.trades} trades`),
    tile('Win rate', formatPercent(stats.winRate), 'flat',
      `${stats.wins}W · ${stats.losses}L${stats.breakeven ? ` · ${stats.breakeven}BE` : ''}`),
    tile('Expectancy', formatR(stats.expectancy), rClass(stats.expectancy), 'per trade'),
    tile('Profit factor', stats.profitFactor ?? '—', rClass((stats.profitFactor ?? 1) - 1),
      stats.profitFactor == null ? 'no losses yet' : 'gross win ÷ gross loss'),
    tile('Avg win', formatR(stats.avgWin), 'up', `best ${formatR(stats.bestR)}`),
    tile('Avg loss', stats.avgLoss == null ? '—' : `-${stats.avgLoss.toFixed(2)}R`, 'down',
      `worst ${formatR(stats.worstR)}`),
    tile('Max drawdown', dd == null ? '—' : `-${dd.toFixed(2)}R`, 'down', 'peak to trough'),
    tile('Streak', streak.kind ? `${streak.current} ${streak.kind === 'win' ? 'W' : 'L'}` : '—',
      streak.kind === 'win' ? 'up' : streak.kind === 'loss' ? 'down' : 'flat',
      `longest ${streak.longestWin}W / ${streak.longestLoss}L`),
  );

  grid.append(el('p', { class: 'stat-note' },
    'From your own entries, not a broker statement.'));

  await renderRecentDays(all);
}

function tile(label, value, tone, sub) {
  return el('div', { class: 'stat-tile', dataset: { tone } },
    el('span', { class: 'stat-tile-label' }, label),
    el('span', { class: 'stat-tile-value' }, String(value)),
    sub ? el('span', { class: 'stat-tile-sub' }, sub) : null,
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

  host.append(el('div', { class: 'day-strip' },
    ...days.map((d) => el('div', { class: 'day-chip', dataset: { tone: rClass(d.r) } },
      el('span', { class: 'day-chip-date' }, shortDate(d.date)),
      el('span', { class: 'day-chip-r' }, formatR(d.r)),
      el('span', { class: 'day-chip-sub' }, `${d.trades} trade${d.trades === 1 ? '' : 's'}`),
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
          hasTrades ? el('span', { class: 'day-r', dataset: { tone: rClass(day.r) } }, formatR(day.r)) : null,
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
        ...['Date', 'Symbol', 'Side', 'R', 'Setups', 'Note', ''].map((h) => el('th', {}, h)),
      )),
      el('tbody', {},
        ...trades.map((t) => el('tr', { dataset: { outcome: t.outcome } },
          el('td', {}, shortDate(t.date)),
          el('td', { class: 'cell-sym' }, t.symbol || '—'),
          el('td', { class: 'muted' }, t.direction),
          el('td', { class: 'cell-r', dataset: { tone: rClass(t.r) } }, formatR(t.r)),
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
      ...['Setup', 'Trades', 'Net R', 'Win rate', 'Expectancy'].map((h) => el('th', {}, h)),
    )),
    el('tbody', {},
      ...rows.map((row) => el('tr', {},
        el('td', {}, el('span', { class: 'tag' }, row.poi)),
        // The count is never far from the verdict: three trades is not evidence.
        el('td', { class: row.trades < 5 ? 'muted' : '' },
          row.trades < 5 ? `${row.trades} — too few to judge` : String(row.trades)),
        el('td', { class: 'cell-r', dataset: { tone: rClass(row.totalR) } }, formatR(row.totalR)),
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
