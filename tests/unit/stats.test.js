/**
 * These are the numbers a trader makes decisions from. They are also the ones
 * the original brief said must never be guessed at — so they are computed only
 * from entered trades, and "no data" must never come back looking like zero.
 */
import { describe, it, expect } from 'vitest';
import {
  computeStats, equityCurve, maxDrawdown, streaks, byDay, byPoi, bySymbol,
  formatR, formatMoney, formatPercent, EMPTY,
} from '../../src/stats.js';
import { makeTrade, dayKey, applyOutcome } from '../../src/trades.js';

/**
 * Terse trade builder: t(2) is a 2R win, t(-1) a 1R loss.
 * The sign picks the outcome here, the way a legacy record would.
 */
const t = (r, over = {}) => makeTrade({ r, date: '2026-01-05', ...over });

describe('computeStats', () => {
  it('reports no data rather than zeros when nothing has been logged', () => {
    // A 0% win rate and an unknown win rate look the same on screen and mean
    // opposite things, so nothing may be invented here.
    const s = computeStats([]);
    expect(s.hasData).toBe(false);
    expect(s.winRate).toBeNull();
    expect(s.expectancy).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s).toEqual(EMPTY);
  });

  it('totals R and counts outcomes', () => {
    const s = computeStats([t(2), t(-1), t(3), t(-1), t(0)]);
    expect(s.trades).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.breakeven).toBe(1);
    expect(s.totalR).toBe(3);
  });

  it('excludes breakeven trades from the win rate', () => {
    // Counting them as losses punishes good risk management; as wins, flatters
    // it. Two wins and two losses is 50%, whatever else happened.
    const s = computeStats([t(2), t(-1), t(1), t(-1), t(0), t(0)]);
    expect(s.winRate).toBe(50);
    expect(s.breakeven).toBe(2);
  });

  it('gives expectancy as the average R per trade', () => {
    // On this record, what one more trade is worth.
    expect(computeStats([t(3), t(-1), t(-1), t(1)]).expectancy).toBe(0.5);
    expect(computeStats([t(-1), t(-1)]).expectancy).toBe(-1);
  });

  it('averages wins and losses separately, losses as positive magnitudes', () => {
    const s = computeStats([t(3), t(1), t(-1), t(-2)]);
    expect(s.avgWin).toBe(2);
    expect(s.avgLoss).toBe(1.5);
  });

  it('computes profit factor, and withholds it when nothing has lost yet', () => {
    expect(computeStats([t(3), t(1), t(-2)]).profitFactor).toBe(2);
    // Infinity is not a fact about a strategy; it means "not enough has happened".
    expect(computeStats([t(3), t(1)]).profitFactor).toBeNull();
  });

  it('reports best and worst single trades', () => {
    const s = computeStats([t(1), t(4.5), t(-2.25), t(0)]);
    expect(s.bestR).toBe(4.5);
    expect(s.worstR).toBe(-2.25);
  });

  it('counts trading days, not calendar days', () => {
    const s = computeStats([
      t(1, { date: '2026-01-05' }),
      t(1, { date: '2026-01-05' }),
      t(-1, { date: '2026-01-09' }),
    ]);
    expect(s.tradingDays).toBe(2);
    expect(s.avgTradesPerDay).toBe(1.5);
  });

  it('survives a record of nothing but breakeven trades', () => {
    const s = computeStats([t(0), t(0)]);
    expect(s.hasData).toBe(true);
    expect(s.totalR).toBe(0);
    // No decisive trades, so a win rate would be a fabrication.
    expect(s.winRate).toBeNull();
    expect(s.avgWin).toBeNull();
    expect(s.avgLoss).toBeNull();
  });

  it('does not accumulate floating point noise', () => {
    const s = computeStats([t(0.1), t(0.2)]);
    expect(s.totalR).toBe(0.3);
  });
});

describe('equity curve and drawdown', () => {
  it('runs the total in trade order, oldest first', () => {
    const curve = equityCurve([
      t(2, { date: '2026-01-06' }),
      t(-1, { date: '2026-01-05' }),
      t(3, { date: '2026-01-07' }),
    ]);
    expect(curve.map((p) => p.cumulative)).toEqual([-1, 1, 4]);
  });

  it('measures the largest peak-to-trough fall', () => {
    // +3 then down to -1 is a fall of 4 from the peak, even though the record
    // is still positive overall.
    const trades = [
      t(3, { date: '2026-01-01' }),
      t(-2, { date: '2026-01-02' }),
      t(-2, { date: '2026-01-03' }),
      t(2, { date: '2026-01-04' }),
    ];
    expect(maxDrawdown(trades).r).toBe(4);
  });

  it('is zero when the record only ever rose, and never negative zero', () => {
    const none = maxDrawdown([t(1), t(2)]);
    expect(none.r).toBe(0);
    // -0 would render as "-0.00R", which reads as a loss that never happened.
    expect(Object.is(none.r, -0)).toBe(false);
    expect(maxDrawdown([])).toBeNull();
  });
});

describe('streaks', () => {
  it('reports the current run and the longest of each kind', () => {
    const trades = [
      t(1, { date: '2026-01-01' }),
      t(1, { date: '2026-01-02' }),
      t(-1, { date: '2026-01-03' }),
      t(-1, { date: '2026-01-04' }),
      t(-1, { date: '2026-01-05' }),
    ];
    const s = streaks(trades);
    expect(s.kind).toBe('loss');
    expect(s.current).toBe(3);
    expect(s.longestWin).toBe(2);
    expect(s.longestLoss).toBe(3);
  });

  it('does not let a breakeven trade break a run', () => {
    const trades = [
      t(1, { date: '2026-01-01' }),
      t(0, { date: '2026-01-02' }),
      t(1, { date: '2026-01-03' }),
    ];
    expect(streaks(trades)).toMatchObject({ kind: 'win', current: 2, longestWin: 2 });
  });

  it('handles an empty record', () => {
    expect(streaks([])).toEqual({ current: 0, kind: null, longestWin: 0, longestLoss: 0 });
  });
});

describe('breakdowns', () => {
  it('totals by day, newest first', () => {
    const days = byDay([
      t(2, { date: '2026-01-05' }),
      t(-1, { date: '2026-01-05' }),
      t(3, { date: '2026-01-06' }),
    ]);
    expect(days[0]).toMatchObject({ date: '2026-01-06', r: 3, trades: 1 });
    expect(days[1]).toMatchObject({ date: '2026-01-05', r: 1, trades: 2, wins: 1, losses: 1 });
  });

  it('scores each of your own reasons, with the count to judge it by', () => {
    // The point of tagging setups is finding out which to keep taking — but a
    // tag with two trades behind it is not evidence, so the count comes too.
    const trades = [
      t(3, { pois: ['FVG', 'OB'] }),
      t(2, { pois: ['FVG'] }),
      t(-1, { pois: ['OB'] }),
      t(-1, { pois: ['OB'] }),
    ];
    const ranked = byPoi(trades);
    expect(ranked[0].poi).toBe('FVG');
    expect(ranked[0].totalR).toBe(5);
    expect(ranked[0].trades).toBe(2);
    expect(ranked[1].poi).toBe('OB');
    expect(ranked[1].totalR).toBe(1);
    expect(ranked[1].trades).toBe(3);
  });

  it('groups by symbol, and labels untagged trades rather than dropping them', () => {
    const rows = bySymbol([t(2, { symbol: 'MNQ' }), t(-1, { symbol: 'MES' }), t(1, {})]);
    expect(rows.map((r) => r.symbol)).toContain('MNQ');
    expect(rows.map((r) => r.symbol)).toContain('—');
  });
});

describe('formatting', () => {
  it('signs R values the way a journal reads', () => {
    expect(formatR(2)).toBe('+2.00R');
    expect(formatR(-1.5)).toBe('-1.50R');
    expect(formatR(0)).toBe('0.00R');
    expect(formatR(null)).toBe('—');
  });

  it('never prints a negative zero', () => {
    // "-0.00R" on the dashboard reads as a loss that never happened.
    expect(formatR(-0)).toBe('0.00R');
    expect(formatMoney(-0)).toBe('$0');
  });

  it('formats money without inventing cents', () => {
    expect(formatMoney(1250)).toBe('+$1,250');
    expect(formatMoney(-312.5)).toBe('-$312.50');
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(null)).toBe('—');
  });

  it('shows a dash for an unknown percentage, never 0%', () => {
    expect(formatPercent(62.5)).toBe('62.5%');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('trade records', () => {
  it('derives the outcome from R', () => {
    expect(makeTrade({ r: 2 }).outcome).toBe('win');
    expect(makeTrade({ r: -1 }).outcome).toBe('loss');
    expect(makeTrade({ r: 0 }).outcome).toBe('breakeven');
  });

  it('carries no field that could be mistaken for broker data', () => {
    const trade = makeTrade({ r: 1, symbol: 'mnq' });
    expect(trade.symbol).toBe('MNQ');
    // Results are self-reported; nothing here claims to be an execution record.
    expect(trade).not.toHaveProperty('fillPrice');
    expect(trade).not.toHaveProperty('commission');
  });

  it('uses the local calendar date, so a late session counts to that evening', () => {
    const late = new Date(2026, 0, 5, 23, 30).getTime();
    expect(dayKey(late)).toBe('2026-01-05');
  });
});

describe('outcome and sign', () => {
  it('signs the amount from the chosen outcome, so a plain number is enough', () => {
    // You pick "loss" and type 100. Making you remember a minus sign is how a
    // journal ends up with a loss recorded as a win.
    expect(applyOutcome('loss', 100)).toBe(-100);
    expect(applyOutcome('win', 100)).toBe(100);
    expect(applyOutcome('breakeven', 100)).toBe(0);

    // A minus already typed is not doubled back into a win.
    expect(applyOutcome('loss', -100)).toBe(-100);
    expect(applyOutcome('win', -100)).toBe(100);
  });

  it('keeps R and money on the same side as the outcome', () => {
    const trade = makeTrade({ outcome: 'loss', r: 1, pnl: 250 });
    expect(trade.outcome).toBe('loss');
    expect(trade.r).toBe(-1);
    expect(trade.pnl).toBe(-250);

    const be = makeTrade({ outcome: 'breakeven', r: 2, pnl: 400 });
    expect(be.r).toBe(0);
    expect(be.pnl).toBe(0);
  });

  it('falls back to reading the sign for a record saved before outcomes were explicit', () => {
    // Regression: the outcome used to be overridable, so editing a +3R win down
    // to a loss left it stored as a win. The row showed the loss while the win
    // rate still counted it as a win.
    expect(makeTrade({ r: 3 }).outcome).toBe('win');
    expect(makeTrade({ r: -1 }).outcome).toBe('loss');
    expect(makeTrade({ r: 0 }).outcome).toBe('breakeven');
  });

  it('flips both amounts when the outcome is changed on an edit', () => {
    // Regression: editing a +3R win into a loss once left it stored as a win,
    // so the row showed the loss while the win rate counted a win.
    const win = makeTrade({ outcome: 'win', r: 3, pnl: 600 });
    const flipped = makeTrade({ ...win, outcome: 'loss' });

    expect(flipped.r).toBe(-3);
    expect(flipped.pnl).toBe(-600);
    expect(computeStats([flipped]).losses).toBe(1);
  });

  it('keeps stats consistent with what is actually stored', () => {
    const win = makeTrade({ r: 2 });
    const flipped = makeTrade({ ...win, outcome: 'loss', r: 1 });
    const s = computeStats([flipped]);
    expect(s.losses).toBe(1);
    expect(s.wins).toBe(0);
    expect(s.totalR).toBe(-1);
  });
});

describe('money alongside R', () => {
  const m = (outcome, r, pnl, over = {}) =>
    makeTrade({ outcome, r, pnl, date: '2026-01-05', ...over });

  it('totals money and R together', () => {
    const s = computeStats([
      m('win', 2, 400), m('loss', 1, 200), m('win', 3, 600), m('breakeven', 0, 0),
    ]);
    expect(s.totalR).toBe(4);
    expect(s.totalPnl).toBe(800);
  });

  it('averages wins and losses in money as positive magnitudes', () => {
    const s = computeStats([m('win', 2, 400), m('win', 1, 200), m('loss', 1, 300)]);
    expect(s.avgWinPnl).toBe(300);
    expect(s.avgLossPnl).toBe(300);
  });

  it('gives expectancy in money as well as R', () => {
    // What taking one more trade is worth, on this record.
    const s = computeStats([m('win', 3, 300), m('loss', 1, 100), m('loss', 1, 100)]);
    expect(s.expectancy).toBeCloseTo(0.33, 2);
    expect(s.expectancyPnl).toBeCloseTo(33.33, 1);
  });

  it('tracks drawdown in money too', () => {
    const dd = maxDrawdown([
      m('win', 3, 300, { date: '2026-01-01' }),
      m('loss', 2, 200, { date: '2026-01-02' }),
      m('loss', 2, 200, { date: '2026-01-03' }),
    ]);
    expect(dd.r).toBe(4);
    expect(dd.pnl).toBe(400);
  });

  it('treats a trade with no money entered as zero, not as missing R', () => {
    const s = computeStats([m('win', 2, 0)]);
    expect(s.totalR).toBe(2);
    expect(s.totalPnl).toBe(0);
  });
});
