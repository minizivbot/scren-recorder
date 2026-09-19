/**
 * Trades and day reviews.
 *
 * This is the authoritative record, and it is deliberately a separate thing
 * from markers. A marker is a label for finding footage — it says "something
 * happened here", nothing more. A trade is what you actually took, entered by
 * hand after the session.
 *
 * Every number the dashboard shows comes from this store and only from this
 * store. Nothing is ever inferred from a recording, from a marker, or from
 * anything typed into a marker: a video is not queryable, and a stat derived
 * from one would be a guess wearing a number's clothes.
 *
 * Results are self-reported. The UI says so, because these are your entries and
 * not a broker statement.
 */

import { openDb, put, listSessions } from './session-recorder.js';

export const OUTCOMES = ['win', 'loss', 'breakeven'];

/** Local calendar date, not UTC — a session at 23:30 belongs to that evening. */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Signs a magnitude to match the chosen outcome.
 *
 * You pick win or loss and type a plain positive number — typing 100 on a loss
 * means you lost 100, not that you gained it. Making the user remember a minus
 * sign is how a journal ends up with a loss recorded as a win.
 */
export function applyOutcome(outcome, magnitude) {
  const abs = Math.abs(Number(magnitude) || 0);
  if (outcome === 'breakeven') return 0;
  return outcome === 'loss' ? -abs : abs;
}

export function makeTrade(data = {}) {
  // The outcome is chosen, not inferred. Both amounts then carry its sign, so
  // they can never disagree with each other or with the outcome.
  const outcome = OUTCOMES.includes(data.outcome) ? data.outcome : outcomeFrom(data.r);
  const r = applyOutcome(outcome, data.r);
  const pnl = applyOutcome(outcome, data.pnl);

  return {
    id: `trd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),

    // Which day this counts toward, and which recording it came from (if any —
    // a trade can be logged without a recording).
    date: data.date || dayKey(),
    sessionId: data.sessionId || null,
    // Optional jump-to point in that recording.
    markerId: data.markerId || null,

    symbol: (data.symbol || '').trim().toUpperCase(),
    direction: data.direction === 'short' ? 'short' : 'long',

    outcome,

    // Risk multiple, signed. Comparable across position sizes: a 2R win is a
    // 2R win whether it was one contract or ten.
    r,

    // Money, signed the same way. Both are kept because they answer different
    // questions — R says whether the decision was good, money says what it did
    // to the account.
    pnl,

    // The trader's own reasons, chosen from the list they define in settings.
    pois: Array.isArray(data.pois) ? data.pois.filter(Boolean) : [],
    note: (data.note || '').trim(),
    ...(data.extra || {}),
  };
}

/** Falls back to reading the sign, for a trade saved before outcomes were explicit. */
function outcomeFrom(r) {
  const n = Number(r) || 0;
  if (n > 0) return 'win';
  if (n < 0) return 'loss';
  return 'breakeven';
}

// ── trades ──────────────────────────────────────────────────────────────────

export async function saveTrade(trade) {
  const db = await openDb();
  // Re-normalise on the way in, so a record can never be stored with an amount
  // whose sign contradicts its outcome. Identity and creation time survive it.
  const record = {
    ...makeTrade(trade),
    id: trade.id ?? undefined,
    createdAt: trade.createdAt ?? undefined,
    updatedAt: Date.now(),
  };
  if (!record.id) record.id = makeTrade({}).id;
  if (!record.createdAt) record.createdAt = Date.now();

  await put(db, 'trades', record);
  return record;
}

export async function listTrades() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('trades').objectStore('trades').getAll();
    // Newest first, and stable within a day by creation order.
    req.onsuccess = () => resolve(req.result.sort(
      (a, b) => (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt),
    ));
    req.onerror = () => reject(req.error);
  });
}

export async function getTrade(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('trades').objectStore('trades').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTrade(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function tradesForSession(sessionId) {
  const all = await listTrades();
  return all.filter((t) => t.sessionId === sessionId);
}

// ── day reviews ─────────────────────────────────────────────────────────────

/**
 * How the day felt, which is a different question from how it scored.
 * A disciplined losing day and a lucky winning one should not read the same in
 * a journal, so the rating is kept apart from the R.
 */
export function makeDayReview(data = {}) {
  return {
    date: data.date || dayKey(),
    rating: clampRating(data.rating),
    note: (data.note || '').trim(),
    updatedAt: Date.now(),
  };
}

function clampRating(v) {
  const n = Math.round(Number(v) || 0);
  return Math.min(5, Math.max(0, n));
}

export async function saveDayReview(review) {
  const db = await openDb();
  const record = makeDayReview(review);
  await put(db, 'days', record);
  return record;
}

export async function getDayReview(date) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('days').objectStore('days').get(date);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listDayReviews() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('days').objectStore('days').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.date.localeCompare(a.date)));
    req.onerror = () => reject(req.error);
  });
}

// ── the journal ─────────────────────────────────────────────────────────────

/**
 * One row per day that has anything in it: trades, a review, or a recording.
 * A day you recorded but took nothing still belongs in a journal — "sat on my
 * hands" is a real entry.
 */
export async function buildJournal() {
  const [trades, reviews, sessions] = await Promise.all([
    listTrades(), listDayReviews(), listSessions(),
  ]);

  const days = new Map();
  const ensure = (date) => {
    if (!days.has(date)) {
      days.set(date, {
        date, trades: [], sessions: [], review: null,
        r: 0, pnl: 0, wins: 0, losses: 0, breakeven: 0,
      });
    }
    return days.get(date);
  };

  for (const t of trades) {
    const day = ensure(t.date);
    day.trades.push(t);
    day.r += t.r;
    day.pnl += t.pnl || 0;
    if (t.outcome === 'win') day.wins++;
    else if (t.outcome === 'loss') day.losses++;
    else day.breakeven++;
  }

  for (const r of reviews) ensure(r.date).review = r;
  for (const s of sessions) ensure(dayKey(s.startedAt)).sessions.push(s);

  return [...days.values()]
    .map((d) => ({ ...d, r: round2(d.r), pnl: round2(d.pnl) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
