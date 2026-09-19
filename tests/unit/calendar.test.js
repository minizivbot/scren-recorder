import { describe, it, expect } from 'vitest';
import {
  monthGrid, monthTotals, dayTone, shiftMonth, dayKey, parseDayKey, WEEKDAYS,
} from '../../src/calendar.js';

const day = (date, { pnl = null, r = null, trades = 1, sessions = 0, rating = null } = {}) => ({
  date,
  pnl,
  r,
  trades: Array.from({ length: trades }, (_, i) => ({ id: `${date}-${i}` })),
  sessions: Array.from({ length: sessions }, (_, i) => ({ id: `s${i}` })),
  review: rating ? { rating } : null,
});

describe('dayTone', () => {
  it('is green on a profitable day and red on a losing one', () => {
    expect(dayTone(day('2026-09-01', { pnl: 250 }))).toBe('win');
    expect(dayTone(day('2026-09-02', { pnl: -120 }))).toBe('loss');
  });

  it('falls back to R when no money was entered', () => {
    expect(dayTone(day('2026-09-03', { pnl: null, r: 2 }))).toBe('win');
    expect(dayTone(day('2026-09-04', { pnl: null, r: -1 }))).toBe('loss');
  });

  it('does not colour a day with no trades', () => {
    // Recording a session is not a result. Tinting it green or red would be
    // inventing an outcome out of footage.
    expect(dayTone(day('2026-09-05', { trades: 0, sessions: 1 }))).toBe('none');
    expect(dayTone(null)).toBe('none');
  });

  it('marks a day that traded and netted exactly flat', () => {
    expect(dayTone(day('2026-09-06', { pnl: 0, r: 0 }))).toBe('flat');
  });
});

describe('monthGrid', () => {
  it('lays out whole weeks starting on Sunday', () => {
    const weeks = monthGrid({ year: 2026, month: 8, days: [], today: new Date(2026, 8, 19) });
    expect(WEEKDAYS[0]).toBe('Sun');
    for (const week of weeks) expect(week.cells).toHaveLength(7);
    // 1 September 2026 is a Tuesday, so the grid opens on 30 August.
    expect(weeks[0].cells[0].key).toBe('2026-08-30');
    expect(weeks[0].cells[0].outside).toBe(true);
    expect(weeks[0].cells[2].key).toBe('2026-09-01');
    expect(weeks[0].cells[2].outside).toBe(false);
  });

  it('covers every day of the month exactly once', () => {
    for (const month of [0, 1, 3, 8, 11]) {
      const weeks = monthGrid({ year: 2026, month, days: [] });
      const inMonth = weeks.flatMap((w) => w.cells).filter((c) => !c.outside);
      const expected = new Date(2026, month + 1, 0).getDate();
      expect(inMonth).toHaveLength(expected);
      expect(new Set(inMonth.map((c) => c.key)).size).toBe(expected);
    }
  });

  it('handles a leap February', () => {
    const cells = monthGrid({ year: 2028, month: 1, days: [] })
      .flatMap((w) => w.cells).filter((c) => !c.outside);
    expect(cells).toHaveLength(29);
    expect(cells.at(-1).key).toBe('2028-02-29');
  });

  it('puts each day box on its own date', () => {
    const days = [day('2026-09-10', { pnl: 400, r: 3 }), day('2026-09-11', { pnl: -150, r: -1 })];
    const cells = monthGrid({ year: 2026, month: 8, days }).flatMap((w) => w.cells);

    const tenth = cells.find((c) => c.key === '2026-09-10');
    expect(tenth.tone).toBe('win');
    expect(tenth.pnl).toBe(400);
    expect(tenth.tradeCount).toBe(1);

    const eleventh = cells.find((c) => c.key === '2026-09-11');
    expect(eleventh.tone).toBe('loss');
    expect(eleventh.pnl).toBe(-150);
  });

  it('shows no figure for a day that was recorded but never logged', () => {
    const days = [day('2026-09-15', { trades: 0, sessions: 1 })];
    const cell = monthGrid({ year: 2026, month: 8, days })
      .flatMap((w) => w.cells).find((c) => c.key === '2026-09-15');
    expect(cell.pnl).toBeNull();
    expect(cell.r).toBeNull();
    expect(cell.tone).toBe('none');
    expect(cell.hasRecording).toBe(true);
  });

  it('totals each week without counting the neighbouring month', () => {
    // 30 and 31 August share a week with 1-5 September.
    const days = [day('2026-08-31', { pnl: 999, r: 9 }), day('2026-09-01', { pnl: 100, r: 1 })];
    const weeks = monthGrid({ year: 2026, month: 8, days });
    expect(weeks[0].pnl).toBe(100);
    expect(weeks[0].trades).toBe(1);
  });

  it('marks today', () => {
    const weeks = monthGrid({ year: 2026, month: 8, days: [], today: new Date(2026, 8, 19) });
    const marked = weeks.flatMap((w) => w.cells).filter((c) => c.isToday);
    expect(marked).toHaveLength(1);
    expect(marked[0].key).toBe('2026-09-19');
  });

  it('does not repeat or skip a date across a DST change', () => {
    // US DST ends 1 November 2026; a naive +24h walk lands on 23:00 the same
    // day and emits it twice.
    const cells = monthGrid({ year: 2026, month: 10, days: [] })
      .flatMap((w) => w.cells).filter((c) => !c.outside);
    expect(new Set(cells.map((c) => c.key)).size).toBe(30);
    expect(cells[0].key).toBe('2026-11-01');
    expect(cells.at(-1).key).toBe('2026-11-30');
  });
});

describe('monthTotals', () => {
  const days = [
    day('2026-09-01', { pnl: 250, r: 2 }),
    day('2026-09-02', { pnl: -100, r: -1 }),
    day('2026-09-03', { trades: 0, sessions: 1 }),
    day('2026-10-01', { pnl: 5000, r: 50 }),
  ];

  it('adds up only the month on screen', () => {
    const totals = monthTotals({ year: 2026, month: 8, days });
    expect(totals.pnl).toBe(150);
    expect(totals.r).toBe(1);
    expect(totals.days).toBe(2);
    expect(totals.greenDays).toBe(1);
    expect(totals.redDays).toBe(1);
  });

  it('says it has nothing rather than reporting zero', () => {
    // A month with no trades has an unknown P&L, not a P&L of zero.
    const totals = monthTotals({ year: 2020, month: 0, days });
    expect(totals.hasData).toBe(false);
    expect(totals.pnl).toBeNull();
    expect(totals.r).toBeNull();
  });
});

describe('month navigation', () => {
  it('steps across the year boundary', () => {
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
  });
});

describe('day keys', () => {
  it('round-trips in local time', () => {
    const key = '2026-03-08';
    expect(dayKey(parseDayKey(key))).toBe(key);
  });

  it('does not shift a date by a day near midnight', () => {
    // Parsing as UTC would make this the 7th west of Greenwich.
    expect(parseDayKey('2026-03-08').getDate()).toBe(8);
    expect(dayKey(new Date(2026, 2, 8, 0, 30))).toBe('2026-03-08');
    expect(dayKey(new Date(2026, 2, 8, 23, 30))).toBe('2026-03-08');
  });
});
