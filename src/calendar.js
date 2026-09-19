/**
 * Month grid for the journal.
 *
 * A list of days tells you what happened; a month laid out as a grid tells you
 * *when* — the Mondays you give back, the week that undid the month, the run
 * of flat days you had forgotten about. That shape only shows up in a calendar.
 *
 * Every number here comes from trades the trader entered by hand. Nothing is
 * inferred from a recording: a day with footage and no trades logged shows a
 * film marker and no figure, because there is no figure to show.
 */

const MS_DAY = 24 * 60 * 60 * 1000;

/** Sunday first: the CME week opens Sunday evening, and it matches the local week. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'YYYY-MM-DD' for a Date, in local time — the same key the journal uses. */
export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parses 'YYYY-MM-DD' as a local date, not UTC — otherwise days shift by one. */
export function parseDayKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/**
 * Which colour a day's box gets.
 *
 * A day is only green or red when there is a figure to justify it. A day with
 * trades that nets exactly flat is 'flat', not a washed-out green — and a day
 * with no trades is 'none', with no box tint at all.
 */
export function dayTone(day) {
  if (!day || !day.trades?.length) return 'none';
  const value = day.pnl ?? null;
  // Fall back to R when no money was recorded: still the trader's own number.
  const measure = value !== null && value !== 0 ? value : (value === 0 ? 0 : day.r ?? 0);
  if (measure > 0) return 'win';
  if (measure < 0) return 'loss';
  return 'flat';
}

/**
 * Builds the weeks of a month.
 *
 * Always whole weeks, so the grid is rectangular; days from the neighbouring
 * months are marked `outside` and rendered faintly rather than omitted, which
 * keeps the columns lined up under their weekday headings.
 *
 * @param {object} options
 * @param {number} options.year
 * @param {number} options.month        0-indexed, as Date uses
 * @param {Array}  options.days         journal days, each with a `date` key
 * @param {Date}   [options.today]
 */
export function monthGrid({ year, month, days = [], today = new Date() }) {
  const byDate = new Map(days.map((d) => [d.date, d]));

  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // back up to the Sunday on or before the 1st

  const last = new Date(year, month + 1, 0);
  const totalCells = Math.ceil((last.getDate() + first.getDay()) / 7) * 7;

  const weeks = [];
  const todayKey = dayKey(today);

  for (let i = 0; i < totalCells; i += 1) {
    const date = new Date(start.getTime() + i * MS_DAY);
    // Built from the timestamp, so a DST shift cannot land us on 23:00 the
    // previous day and silently repeat a date.
    date.setHours(12, 0, 0, 0);
    const key = dayKey(date);
    const day = byDate.get(key) || null;

    const cell = {
      key,
      dayOfMonth: date.getDate(),
      outside: date.getMonth() !== month,
      isToday: key === todayKey,
      day,
      tone: dayTone(day),
      pnl: day?.trades?.length ? day.pnl ?? null : null,
      r: day?.trades?.length ? day.r ?? null : null,
      tradeCount: day?.trades?.length || 0,
      hasRecording: (day?.sessions?.length || 0) > 0,
      rating: day?.review?.rating ?? null,
    };

    if (i % 7 === 0) weeks.push({ cells: [], pnl: 0, r: 0, trades: 0, hasData: false });
    const week = weeks[weeks.length - 1];
    week.cells.push(cell);

    // Weekly totals count only days of this month, so a week spanning the turn
    // of the month does not double-count into both.
    if (!cell.outside && cell.tradeCount) {
      week.pnl += day.pnl || 0;
      week.r += day.r || 0;
      week.trades += cell.tradeCount;
      week.hasData = true;
    }
  }

  return weeks;
}

/** Month totals, from the same hand-entered trades and nothing else. */
export function monthTotals({ year, month, days = [] }) {
  const inMonth = days.filter((d) => {
    const date = parseDayKey(d.date);
    return date.getFullYear() === year && date.getMonth() === month && d.trades?.length;
  });

  if (!inMonth.length) {
    return { hasData: false, pnl: null, r: null, trades: 0, greenDays: 0, redDays: 0, days: 0 };
  }

  return {
    hasData: true,
    pnl: inMonth.reduce((sum, d) => sum + (d.pnl || 0), 0),
    r: inMonth.reduce((sum, d) => sum + (d.r || 0), 0),
    trades: inMonth.reduce((sum, d) => sum + d.trades.length, 0),
    greenDays: inMonth.filter((d) => dayTone(d) === 'win').length,
    redDays: inMonth.filter((d) => dayTone(d) === 'loss').length,
    days: inMonth.length,
  };
}

/** Steps a month, handling the year boundary. */
export function shiftMonth({ year, month }, delta) {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function monthLabel({ year, month }) {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
