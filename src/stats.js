/**
 * Performance statistics, computed from hand-entered trades and nothing else.
 *
 * Pure functions on purpose: the numbers a trader makes decisions from should
 * be testable without a browser, a database or a recording anywhere near them.
 *
 * Everything is in R — risk multiples — because that is the only unit that
 * compares a trade across position sizes. A 2R win is a 2R win whether it was
 * one contract or ten.
 *
 * Nothing here ever reads a session, a marker or a video. If there are no
 * trades the answer is "no data", never a zero dressed up as a result: a 0%
 * win rate and an unknown win rate look identical on screen and mean opposite
 * things.
 */

export const EMPTY = {
  hasData: false,
  trades: 0,
  wins: 0,
  losses: 0,
  breakeven: 0,
  totalR: 0,
  winRate: null,
  expectancy: null,
  avgWin: null,
  avgLoss: null,
  profitFactor: null,
  bestR: null,
  worstR: null,
  tradingDays: 0,
  avgTradesPerDay: null,
};

export function computeStats(trades = []) {
  if (!trades.length) return { ...EMPTY };

  const wins = trades.filter((t) => t.outcome === 'win');
  const losses = trades.filter((t) => t.outcome === 'loss');
  const breakeven = trades.filter((t) => t.outcome === 'breakeven');

  const totalR = sum(trades.map((t) => t.r));
  const grossWin = sum(wins.map((t) => t.r));
  const grossLoss = Math.abs(sum(losses.map((t) => t.r)));

  // Breakeven trades are excluded from the win rate denominator. Counting them
  // as losses would punish good risk management; counting them as wins would
  // flatter it. They are reported separately instead.
  const decisive = wins.length + losses.length;

  const days = new Set(trades.map((t) => t.date));

  return {
    hasData: true,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,

    totalR: round2(totalR),
    winRate: decisive ? round1((wins.length / decisive) * 100) : null,

    // In R, expectancy is simply the average outcome per trade — what one more
    // trade is worth, on this record.
    expectancy: round2(totalR / trades.length),

    avgWin: wins.length ? round2(grossWin / wins.length) : null,
    avgLoss: losses.length ? round2(grossLoss / losses.length) : null,

    // Undefined rather than Infinity when nothing has lost yet: a profit factor
    // with no losses in it is not a fact about the strategy.
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,

    bestR: round2(Math.max(...trades.map((t) => t.r))),
    worstR: round2(Math.min(...trades.map((t) => t.r))),

    tradingDays: days.size,
    avgTradesPerDay: round1(trades.length / days.size),
  };
}

/** Running total of R, oldest first — the shape of the equity curve. */
export function equityCurve(trades = []) {
  const ordered = [...trades].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt,
  );
  let running = 0;
  return ordered.map((t) => {
    running += t.r;
    return { id: t.id, date: t.date, r: t.r, cumulative: round2(running) };
  });
}

/** Largest peak-to-trough fall in R. */
export function maxDrawdown(trades = []) {
  const curve = equityCurve(trades);
  if (!curve.length) return null;

  let peak = 0;
  let worst = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.cumulative);
    worst = Math.min(worst, point.cumulative - peak);
  }
  return round2(Math.abs(worst));
}

/** Current run of wins or losses, and the longest of each. */
export function streaks(trades = []) {
  const ordered = [...trades]
    .filter((t) => t.outcome !== 'breakeven')
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

  if (!ordered.length) return { current: 0, kind: null, longestWin: 0, longestLoss: 0 };

  let longestWin = 0;
  let longestLoss = 0;
  let run = 0;
  let kind = null;

  for (const t of ordered) {
    if (t.outcome === kind) run++;
    else { kind = t.outcome; run = 1; }

    if (kind === 'win') longestWin = Math.max(longestWin, run);
    else longestLoss = Math.max(longestLoss, run);
  }

  return { current: run, kind, longestWin, longestLoss };
}

/** Per-day totals, newest first. */
export function byDay(trades = []) {
  const days = new Map();
  for (const t of trades) {
    if (!days.has(t.date)) days.set(t.date, { date: t.date, r: 0, trades: 0, wins: 0, losses: 0 });
    const day = days.get(t.date);
    day.r += t.r;
    day.trades++;
    if (t.outcome === 'win') day.wins++;
    else if (t.outcome === 'loss') day.losses++;
  }
  return [...days.values()]
    .map((d) => ({ ...d, r: round2(d.r) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Which of your own reasons actually work.
 *
 * This is the point of tagging setups at all — not to label them, but to find
 * out later which ones you should be taking. Only tags with enough trades to
 * mean anything are worth reading, so the count is always reported alongside.
 */
export function byPoi(trades = []) {
  const tags = new Map();
  for (const t of trades) {
    for (const poi of t.pois || []) {
      if (!tags.has(poi)) tags.set(poi, []);
      tags.get(poi).push(t);
    }
  }
  return [...tags.entries()]
    .map(([poi, list]) => ({ poi, ...computeStats(list) }))
    .sort((a, b) => b.totalR - a.totalR);
}

/** Per-symbol breakdown, same idea. */
export function bySymbol(trades = []) {
  const symbols = new Map();
  for (const t of trades) {
    const key = t.symbol || '—';
    if (!symbols.has(key)) symbols.set(key, []);
    symbols.get(key).push(t);
  }
  return [...symbols.entries()]
    .map(([symbol, list]) => ({ symbol, ...computeStats(list) }))
    .sort((a, b) => b.totalR - a.totalR);
}

/** Trades from the last N days, for a rolling view. */
export function recent(trades = [], days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const key = cutoff.toISOString().slice(0, 10);
  return trades.filter((t) => t.date >= key);
}

function sum(numbers) {
  return numbers.reduce((a, b) => a + b, 0);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Formats an R value the way a journal reads: signed, two decimals. */
export function formatR(r) {
  if (r == null || !Number.isFinite(r)) return '—';
  const rounded = round2(r);
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}R`;
}

export function formatPercent(v) {
  return v == null ? '—' : `${v}%`;
}
