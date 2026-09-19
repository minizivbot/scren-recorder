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
  totalPnl: 0,
  winRate: null,
  expectancy: null,
  expectancyPnl: null,
  avgWin: null,
  avgLoss: null,
  avgWinPnl: null,
  avgLossPnl: null,
  profitFactor: null,
  bestR: null,
  worstR: null,
  bestPnl: null,
  worstPnl: null,
  tradingDays: 0,
  avgTradesPerDay: null,
};

export function computeStats(trades = []) {
  if (!trades.length) return { ...EMPTY };

  const wins = trades.filter((t) => t.outcome === 'win');
  const losses = trades.filter((t) => t.outcome === 'loss');
  const breakeven = trades.filter((t) => t.outcome === 'breakeven');

  const totalR = sum(trades.map((t) => t.r));
  const totalPnl = sum(trades.map((t) => t.pnl || 0));
  const grossWin = sum(wins.map((t) => t.r));
  const grossLoss = Math.abs(sum(losses.map((t) => t.r)));
  const grossWinPnl = sum(wins.map((t) => t.pnl || 0));
  const grossLossPnl = Math.abs(sum(losses.map((t) => t.pnl || 0)));

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
    totalPnl: round2(totalPnl),
    winRate: decisive ? round1((wins.length / decisive) * 100) : null,

    // Expectancy is the average outcome per trade — what taking one more is
    // worth, on this record. It is the number that decides whether a strategy
    // makes money: a 70% win rate with negative expectancy still loses.
    expectancy: round2(totalR / trades.length),
    expectancyPnl: round2(totalPnl / trades.length),

    avgWin: wins.length ? round2(grossWin / wins.length) : null,
    avgLoss: losses.length ? round2(grossLoss / losses.length) : null,
    avgWinPnl: wins.length ? round2(grossWinPnl / wins.length) : null,
    avgLossPnl: losses.length ? round2(grossLossPnl / losses.length) : null,

    // Undefined rather than Infinity when nothing has lost yet: a profit factor
    // with no losses in it is not a fact about the strategy.
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,

    bestR: round2(Math.max(...trades.map((t) => t.r))),
    worstR: round2(Math.min(...trades.map((t) => t.r))),
    bestPnl: round2(Math.max(...trades.map((t) => t.pnl || 0))),
    worstPnl: round2(Math.min(...trades.map((t) => t.pnl || 0))),

    tradingDays: days.size,
    avgTradesPerDay: round1(trades.length / days.size),
  };
}

/** Running totals, oldest first — the shape of the equity curve. */
export function equityCurve(trades = []) {
  const ordered = [...trades].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt,
  );
  let runningR = 0;
  let runningPnl = 0;
  return ordered.map((t) => {
    runningR += t.r;
    runningPnl += t.pnl || 0;
    return {
      id: t.id, date: t.date, r: t.r, pnl: t.pnl || 0,
      cumulative: round2(runningR), cumulativePnl: round2(runningPnl),
    };
  });
}

/** Largest peak-to-trough fall, in R and in money. */
export function maxDrawdown(trades = []) {
  const curve = equityCurve(trades);
  if (!curve.length) return null;

  const fall = (key) => {
    let peak = 0;
    let worst = 0;
    for (const point of curve) {
      peak = Math.max(peak, point[key]);
      worst = Math.min(worst, point[key] - peak);
    }
    // Math.abs(-0) is 0, which keeps "-0.00R" off the screen.
    return round2(Math.abs(worst));
  };

  return { r: fall('cumulative'), pnl: fall('cumulativePnl') };
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
    if (!days.has(t.date)) {
      days.set(t.date, { date: t.date, r: 0, pnl: 0, trades: 0, wins: 0, losses: 0 });
    }
    const day = days.get(t.date);
    day.r += t.r;
    day.pnl += t.pnl || 0;
    day.trades++;
    if (t.outcome === 'win') day.wins++;
    else if (t.outcome === 'loss') day.losses++;
  }
  return [...days.values()]
    .map((d) => ({ ...d, r: round2(d.r), pnl: round2(d.pnl) }))
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
  // `+ 0` collapses -0 to 0: "-0.00R" reads as a loss that never happened.
  const rounded = round2(r) + 0;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}R`;
}

/** Money, signed, with no trailing cents when there are none. */
export function formatMoney(value, currency = '$') {
  if (value == null || !Number.isFinite(value)) return '—';
  const rounded = round2(value) + 0;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const body = Number.isInteger(abs)
    ? abs.toLocaleString()
    : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${currency}${body}`;
}

export function formatPercent(v) {
  return v == null ? '—' : `${v}%`;
}
