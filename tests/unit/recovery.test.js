/**
 * Refreshing mid-session must cost at most one timeslice. The chunks already on
 * disk are a valid prefix of a webm stream, so the session stays playable — it
 * just needs an honest duration and a flag saying it was cut short.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import {
  SessionRecorder, SESSION_STATUS, getSession, getSessionBlob, listSessions,
  recoverInterruptedSessions,
} from '../../src/session-recorder.js';
import { installBrowserMocks, latestRecorder, flush, blobBytes } from '../helpers/browser-mocks.js';

const T0 = 1_700_000_000_000;

/**
 * Records a few timeslices and then walks away without calling stop(), which is
 * exactly what a page refresh or a tab crash leaves behind.
 */
async function recordThenVanish({ chunks = 5, timesliceMs = 2000, setClock }) {
  const rec = new SessionRecorder({ timesliceMs });
  const sessionId = await rec.start({ note: 'morning session' });
  const mr = latestRecorder();

  for (let i = 0; i < chunks; i++) {
    setClock(T0 + (i + 1) * timesliceMs);
    mr.emit(new Uint8Array([i]));
    await flush(3);
  }
  setClock(T0 + 3000 + chunks * timesliceMs);
  rec.openNewTrade({ symbol: 'MNQ', direction: 'long' });
  rec.mark({ kind: 'entry' });
  await flush(5);

  // No stop(). The recorder instance simply ceases to exist.
  return { sessionId, lastChunkAtMs: chunks * timesliceMs };
}

describe('recovery of an interrupted session', () => {
  let clock;
  const setClock = (v) => { clock = v; };

  beforeEach(async () => {
    await resetDatabase();
    installBrowserMocks();
    clock = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => vi.restoreAllMocks());

  it('marks a stale in-progress session as interrupted and gives it a real duration', async () => {
    const { sessionId, lastChunkAtMs } = await recordThenVanish({ chunks: 5, setClock });

    expect((await getSession(sessionId)).status).toBe(SESSION_STATUS.RECORDING);

    // The page reloads a minute later.
    clock = T0 + 60_000;
    const recovered = await recoverInterruptedSessions({ now: clock });

    expect(recovered).toHaveLength(1);
    const session = await getSession(sessionId);
    expect(session.status).toBe(SESSION_STATUS.INTERRUPTED);
    expect(session.interrupted).toBe(true);
    // Duration comes from the last chunk actually on disk, not from wall clock.
    expect(session.durationMs).toBe(lastChunkAtMs);
    expect(session.endedAt).toBe(T0 + lastChunkAtMs);
  });

  it('keeps every chunk written before the interruption, and stays playable', async () => {
    const { sessionId } = await recordThenVanish({ chunks: 5, setClock });
    clock = T0 + 60_000;
    await recoverInterruptedSessions({ now: clock });

    const bytes = await blobBytes(await getSessionBlob(sessionId));
    expect([...bytes]).toEqual([0, 1, 2, 3, 4]);

    const session = await getSession(sessionId);
    expect(session.chunkCount).toBe(5);
    expect(session.bytes).toBe(5);
  });

  it('loses at most the timeslice that was still being buffered', async () => {
    const timesliceMs = 2000;
    const { sessionId } = await recordThenVanish({ chunks: 4, timesliceMs, setClock });

    // Interrupted 1.9s into the fifth timeslice: that partial chunk was never
    // handed to us by MediaRecorder, so it is the only thing that can be lost.
    clock = T0 + 4 * timesliceMs + 1_900;
    await recoverInterruptedSessions({ now: clock + 60_000 });

    const session = await getSession(sessionId);
    const lostMs = (clock - T0) - session.durationMs;
    expect(lostMs).toBeLessThanOrEqual(timesliceMs);
    expect(lostMs).toBe(1_900);
  });

  it('preserves the markers and the trade recorded before the interruption', async () => {
    const { sessionId } = await recordThenVanish({ chunks: 3, setClock });
    clock = T0 + 60_000;
    await recoverInterruptedSessions({ now: clock });

    const session = await getSession(sessionId);
    expect(session.markers).toHaveLength(1);
    expect(session.meta).toEqual({ note: 'morning session' });

    // What was being traded survives on the trade, and the marker still points
    // at it — an interrupted session is still a readable journal entry.
    expect(session.trades).toHaveLength(1);
    expect(session.trades[0].symbol).toBe('MNQ');
    expect(session.trades[0].direction).toBe('long');
    expect(session.markers[0].tradeId).toBe(session.trades[0].id);
  });

  it('leaves a session alone while another tab is still writing to it', async () => {
    const { sessionId } = await recordThenVanish({ chunks: 3, setClock });

    // Heartbeat is only two seconds old — someone is recording right now.
    const recovered = await recoverInterruptedSessions({ now: clock + 2_000 });

    expect(recovered).toHaveLength(0);
    expect((await getSession(sessionId)).status).toBe(SESSION_STATUS.RECORDING);
  });

  it('does not touch sessions that were stopped cleanly', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    latestRecorder().emit(new Uint8Array([7]));
    await flush();
    clock = T0 + 10_000;
    await rec.stop();

    clock = T0 + 10_000_000;
    expect(await recoverInterruptedSessions({ now: clock })).toHaveLength(0);
    const session = await getSession(sessionId);
    expect(session.status).toBe(SESSION_STATUS.COMPLETE);
    expect(session.durationMs).toBe(10_000);
  });

  it('is idempotent across repeated page loads', async () => {
    const { sessionId } = await recordThenVanish({ chunks: 2, setClock });
    clock = T0 + 60_000;

    await recoverInterruptedSessions({ now: clock });
    const first = await getSession(sessionId);
    const second = await recoverInterruptedSessions({ now: clock + 60_000 });

    expect(second).toHaveLength(0);
    expect(await getSession(sessionId)).toEqual(first);
  });

  it('recovers a session that died before any chunk was written', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    await flush();

    clock = T0 + 60_000;
    await recoverInterruptedSessions({ now: clock });

    const session = await getSession(sessionId);
    expect(session.status).toBe(SESSION_STATUS.INTERRUPTED);
    expect(session.durationMs).toBe(0);
    expect(await getSessionBlob(sessionId)).toBeNull();
    // It still shows up in the library rather than vanishing silently.
    expect((await listSessions()).map((s) => s.id)).toContain(sessionId);
  });
});
