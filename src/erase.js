/**
 * Deleting everything, for real.
 *
 * Because nothing is ever sent anywhere, deleting locally IS deletion — there
 * is no request to make of anyone and nothing to wait for. That only holds if
 * this actually removes all of it, so it clears every store, every recording
 * file, and the settings, rather than just emptying the library view.
 */
import {
  listSessions, deleteSession, openDb, _resetDbForTests,
} from './session-recorder.js';
import { listTrades, deleteTrade, listDayReviews } from './trades.js';

const SETTINGS_KEY = 'trade-journal:settings';

/**
 * Wipes the lot and reports what went.
 *
 * Recordings are deleted through deleteSession so the video files on disk go
 * with the rows — removing only the rows would leave gigabytes behind with
 * nothing left pointing at them.
 */
export async function eraseEverything({ keepSettings = false } = {}) {
  const removed = { sessions: 0, recordings: 0, trades: 0, days: 0, bytes: 0 };

  const sessions = await listSessions();
  for (const session of sessions) {
    const freed = await deleteSession(session.id).catch(() => null);
    removed.sessions++;
    if (freed?.bytes) removed.bytes += freed.bytes;
    if (session.storage?.kind === 'file' || freed?.bytes) removed.recordings++;
  }

  for (const trade of await listTrades()) {
    await deleteTrade(trade.id);
    removed.trades++;
  }

  const days = await listDayReviews();
  await clearStore('days');
  removed.days = days.length;

  // Anything left behind by an older version, or a row a delete missed.
  await clearStore('trades');
  await clearStore('chunks');
  await clearStore('sessions');

  if (!keepSettings) {
    try { localStorage.removeItem(SETTINGS_KEY); } catch { /* private window */ }
  }

  return removed;
}

function clearStore(name) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(name)) { resolve(); return; }
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export { _resetDbForTests };
