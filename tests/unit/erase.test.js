/**
 * "Delete everything" has to mean it.
 *
 * The privacy claim is that deleting locally is deletion, because nothing was
 * ever sent anywhere. That is only true if this actually clears all of it — a
 * wipe that leaves the recordings on disk, or the trades in the database, is
 * worse than no button at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import { installBrowserMocks, latestRecorder, flush } from '../helpers/browser-mocks.js';
import { eraseEverything } from '../../src/erase.js';
import {
  SessionRecorder, listSessions, listChunkMeta, getSessionBlob,
} from '../../src/session-recorder.js';
import {
  saveTrade, makeTrade, listTrades, saveDayReview, listDayReviews,
} from '../../src/trades.js';

async function seed() {
  const rec = new SessionRecorder();
  const sessionId = await rec.start();
  latestRecorder().emit(new Uint8Array(4000));
  latestRecorder().emit(new Uint8Array(4000));
  await flush(10);
  await rec.stop();

  await saveTrade(makeTrade({ outcome: 'win', r: 2, pnl: 400, symbol: 'MNQ' }));
  await saveTrade(makeTrade({ outcome: 'loss', r: 1, pnl: 200, symbol: 'MES' }));
  await saveDayReview({ date: '2026-01-05', rating: 4, note: 'good day' });

  localStorage.setItem('trade-journal:settings', JSON.stringify({ preRollMs: 45_000 }));
  return sessionId;
}

describe('deleting everything', () => {
  beforeEach(async () => {
    await resetDatabase();
    installBrowserMocks();
    globalThis.localStorage = {
      _v: {},
      getItem(k) { return this._v[k] ?? null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; },
    };
  });

  afterEach(() => vi.restoreAllMocks());

  it('leaves nothing behind in any store', async () => {
    const sessionId = await seed();

    expect(await listSessions()).toHaveLength(1);
    expect(await listTrades()).toHaveLength(2);

    await eraseEverything();

    expect(await listSessions()).toHaveLength(0);
    expect(await listTrades()).toHaveLength(0);
    expect(await listDayReviews()).toHaveLength(0);
    // The video itself, not merely the row that pointed at it.
    expect(await listChunkMeta(sessionId)).toHaveLength(0);
    expect(await getSessionBlob(sessionId)).toBeNull();
    expect(localStorage.getItem('trade-journal:settings')).toBeNull();
  });

  it('reports what it removed, so the confirmation is not an abstraction', async () => {
    await seed();
    const removed = await eraseEverything();

    expect(removed.sessions).toBe(1);
    expect(removed.trades).toBe(2);
    expect(removed.days).toBe(1);
    expect(removed.bytes).toBe(8000);
  });

  it('removes the recording files on disk in the desktop app', async () => {
    const deleted = [];
    globalThis.desktop = {
      recordings: {
        open: async (id) => `/videos/${id}.webm`,
        write: async () => {},
        close: async () => ({ file: '/videos/x.webm', bytes: 12_345 }),
        url: async () => null,
        remove: async (id) => { deleted.push(id); return { bytes: 12_345 }; },
      },
    };

    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    latestRecorder().emit(new Uint8Array(500));
    await flush(10);
    await rec.stop();

    await eraseEverything();

    // Deleting only the library row would leave gigabytes on disk with nothing
    // pointing at them.
    expect(deleted).toEqual([sessionId]);
    delete globalThis.desktop;
  });

  it('can keep settings when asked, for a reset that is not a wipe', async () => {
    await seed();
    await eraseEverything({ keepSettings: true });

    expect(await listTrades()).toHaveLength(0);
    expect(localStorage.getItem('trade-journal:settings')).not.toBeNull();
  });

  it('is safe to run on an empty journal', async () => {
    const removed = await eraseEverything();
    expect(removed).toMatchObject({ sessions: 0, trades: 0, days: 0, bytes: 0 });
  });

  it('carries on past a session that fails to delete', async () => {
    await seed();
    await saveTrade(makeTrade({ outcome: 'win', r: 1, pnl: 100 }));

    // A recording whose file cannot be removed must not strand the trades and
    // notes behind it — a half-finished wipe is the worst outcome here.
    globalThis.desktop = {
      recordings: { remove: async () => { throw new Error('file locked'); } },
    };
    const sessions = await listSessions();
    await import('../../src/session-recorder.js').then(async (m) => {
      const db = await m.openDb();
      await m.put(db, 'sessions', { ...sessions[0], storage: { kind: 'file' } });
    });

    await eraseEverything();

    expect(await listSessions()).toHaveLength(0);
    expect(await listTrades()).toHaveLength(0);
    expect(await listDayReviews()).toHaveLength(0);
    delete globalThis.desktop;
  });
});
