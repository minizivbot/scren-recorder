/**
 * The instrument and the side are stated once per trade.
 *
 * This is the rule the whole journal rests on: you are long MNQ once, not once
 * per note you take while you are in it. These tests pin that down from both
 * ends — a mark never has to be told what it is about, and a session recorded
 * under the old shape still reads correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import {
  SessionRecorder, getSession, putSession,
  makeTrade, normalizeSession, tradeAtOffset, groupMarkersByTrade, tradeLabel,
  addTradeToSession, updateSessionTrade, removeSessionTrade, assignMarkerToTrade,
} from '../../src/session-recorder.js';
import { installBrowserMocks, flush } from '../helpers/browser-mocks.js';

const T0 = 1_700_000_000_000;

describe('trades carry the instrument, markers do not', () => {
  let clock;
  const at = (ms) => { clock = T0 + ms; };

  beforeEach(async () => {
    await resetDatabase();
    installBrowserMocks();
    clock = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => vi.restoreAllMocks());

  it('files every mark under the open trade without being told', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();

    at(10_000);
    const trade = rec.openNewTrade({ symbol: 'MNQ', direction: 'long', account: 'live' });

    // Three marks, none of which mentions an instrument. That is the point.
    at(11_000); rec.mark({ kind: 'entry' });
    at(60_000); rec.mark({ kind: 'note', note: 'held the retest' });
    at(90_000); rec.mark({ kind: 'exit' });
    at(91_000); rec.closeTrade();

    await flush();
    await rec.stop();

    const session = await getSession(sessionId);
    expect(session.trades).toHaveLength(1);
    expect(session.trades[0]).toMatchObject({ symbol: 'MNQ', direction: 'long', account: 'live' });
    expect(session.markers.every((m) => m.tradeId === trade.id)).toBe(true);
    expect(session.markers.map((m) => m.kind)).toEqual(['entry', 'note', 'exit']);
    // The label the whole app reads the trade by is derived, never re-typed.
    expect(tradeLabel(session.trades[0])).toBe('MNQ LONG');
  });

  it('leaves marks taken outside a position unfiled rather than guessing', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();

    at(5_000); rec.mark({ kind: 'note', note: 'pre-open plan' });
    at(10_000); rec.openNewTrade({ symbol: 'MES', direction: 'short' });
    at(12_000); rec.mark({ kind: 'entry' });
    at(30_000); rec.closeTrade();
    at(40_000); rec.mark({ kind: 'note', note: 'flat, waiting' });

    await flush();
    await rec.stop();

    const session = await getSession(sessionId);
    const { groups, unfiled } = groupMarkersByTrade(session);
    expect(groups).toHaveLength(1);
    expect(groups[0].markers.map((m) => m.offsetMs)).toEqual([12_000]);
    expect(unfiled.map((m) => m.offsetMs)).toEqual([5_000, 40_000]);
  });

  it('opens a trade with nothing typed and takes the details while it runs', async () => {
    // Pressing entry the instant you click buy must never wait on typing.
    const rec = new SessionRecorder();
    const sessionId = await rec.start();

    at(3_000);
    const trade = rec.openNewTrade();
    rec.mark({ kind: 'entry' });
    expect(trade.symbol).toBe('');

    at(20_000);
    rec.updateTrade(trade.id, { symbol: 'nq', direction: 'long' });

    await flush();
    await rec.stop();

    const session = await getSession(sessionId);
    // Instruments are shouted in upper case everywhere; normalized on the way in.
    expect(session.trades[0].symbol).toBe('NQ');
    expect(session.markers[0].tradeId).toBe(trade.id);
  });

  it('closes an open position when the recording stops', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();

    at(1_000);
    rec.openNewTrade({ symbol: 'MNQ', direction: 'long' });
    await flush();

    at(50_000);
    await rec.stop();

    const session = await getSession(sessionId);
    // There is no more footage to be in the position for.
    expect(session.trades[0].closedAtMs).toBe(50_000);
  });

  it('opening a second trade closes the first — one position at a time', async () => {
    const rec = new SessionRecorder();
    await rec.start();

    at(1_000);
    const first = rec.openNewTrade({ symbol: 'MNQ', direction: 'long' });
    at(30_000);
    const second = rec.openNewTrade({ symbol: 'MES', direction: 'short' });

    expect(rec.trades.find((t) => t.id === first.id).closedAtMs).toBe(30_000);
    expect(rec.openTradeId).toBe(second.id);

    at(40_000); rec.mark({ kind: 'note' });
    expect(rec.markers.at(-1).tradeId).toBe(second.id);

    await flush();
    await rec.stop();
  });

  it('rejects a side a select could never produce', () => {
    const trade = makeTrade({ symbol: ' mnq ', direction: 'sideways', account: 'demo' });
    expect(trade.symbol).toBe('MNQ');
    expect(trade.direction).toBe('');
    expect(trade.account).toBe('');
  });
});

describe('editing trades in review', () => {
  beforeEach(async () => {
    await resetDatabase();
    installBrowserMocks();
  });

  async function sessionWithTrade() {
    const session = {
      id: 'sess_review', startedAt: Date.now(), durationMs: 600_000,
      markers: [], trades: [], status: 'complete', complete: true,
    };
    await putSession(session);
    return session.id;
  }

  it('names a trade once and every mark under it reads the new name', async () => {
    const sessionId = await sessionWithTrade();
    const trade = await addTradeToSession(sessionId, { openedAtMs: 10_000 });

    await updateSessionTrade(sessionId, trade.id, { symbol: 'mnq', direction: 'short' });
    const session = await getSession(sessionId);

    expect(session.trades[0].symbol).toBe('MNQ');
    expect(session.trades[0].direction).toBe('short');
    expect(tradeLabel(session.trades[0])).toBe('MNQ SHORT');
  });

  it('keeps the marks when a trade is deleted — the footage is the expensive part', async () => {
    const sessionId = await sessionWithTrade();
    const trade = await addTradeToSession(sessionId, { openedAtMs: 10_000, symbol: 'MNQ' });

    const session = await getSession(sessionId);
    session.markers = [
      { id: 'mk1', offsetMs: 11_000, kind: 'entry', tradeId: trade.id, note: 'worth keeping' },
    ];
    await putSession(session);

    await removeSessionTrade(sessionId, trade.id);
    const after = await getSession(sessionId);

    expect(after.trades).toHaveLength(0);
    expect(after.markers).toHaveLength(1);
    expect(after.markers[0].tradeId).toBeNull();
    expect(after.markers[0].note).toBe('worth keeping');
  });

  it('files a scrubbed mark under whatever position was running at that moment', async () => {
    const sessionId = await sessionWithTrade();
    const early = await addTradeToSession(sessionId, { openedAtMs: 10_000, symbol: 'MNQ' });
    await updateSessionTrade(sessionId, early.id, { note: '' });

    const session = await getSession(sessionId);
    session.trades[0].closedAtMs = 100_000;
    await putSession(session);

    const reloaded = await getSession(sessionId);
    expect(tradeAtOffset(reloaded, 50_000)?.id).toBe(early.id);
    expect(tradeAtOffset(reloaded, 5_000)).toBeNull();
    expect(tradeAtOffset(reloaded, 200_000)).toBeNull();
  });

  it('refiles a mark under a different trade, or under none', async () => {
    const sessionId = await sessionWithTrade();
    const trade = await addTradeToSession(sessionId, { openedAtMs: 10_000, symbol: 'MNQ' });

    const session = await getSession(sessionId);
    session.markers = [{ id: 'mk1', offsetMs: 11_000, kind: 'note', tradeId: null }];
    await putSession(session);

    expect((await assignMarkerToTrade(sessionId, 'mk1', trade.id)).tradeId).toBe(trade.id);
    expect((await assignMarkerToTrade(sessionId, 'mk1', '')).tradeId).toBeNull();
  });
});

describe('sessions recorded before trades existed', () => {
  it('lifts the instrument off the markers onto one trade per position', () => {
    // The old shape: every marker carried its own copy of the same answer.
    const legacy = {
      id: 'sess_old',
      startedAt: T0,
      markers: [
        { id: 'a', offsetMs: 10_000, kind: 'entry', symbol: 'MNQ', direction: 'long', account: 'live', note: '' },
        { id: 'b', offsetMs: 40_000, kind: 'note', symbol: 'MNQ', direction: 'long', account: 'live', note: 'adding' },
        { id: 'c', offsetMs: 90_000, kind: 'exit', symbol: 'MNQ', direction: 'long', account: 'live', note: '' },
        { id: 'd', offsetMs: 120_000, kind: 'entry', symbol: 'MES', direction: 'short', account: 'live', note: '' },
        { id: 'e', offsetMs: 150_000, kind: 'note', symbol: '', direction: '', account: '', note: 'just a thought' },
      ],
    };

    const session = normalizeSession(legacy);

    expect(session.trades).toHaveLength(2);
    const [mnq, mes] = session.trades;
    expect(mnq).toMatchObject({ symbol: 'MNQ', direction: 'long', openedAtMs: 10_000, closedAtMs: 90_000 });
    expect(mes).toMatchObject({ symbol: 'MES', direction: 'short', openedAtMs: 120_000 });

    const byId = Object.fromEntries(session.markers.map((m) => [m.id, m]));
    expect(byId.a.tradeId).toBe(mnq.id);
    expect(byId.b.tradeId).toBe(mnq.id);
    expect(byId.c.tradeId).toBe(mnq.id);
    expect(byId.d.tradeId).toBe(mes.id);
    // A marker that never named an instrument is left unfiled, not invented.
    expect(byId.e.tradeId).toBeNull();

    // The duplicated columns are gone from the markers themselves.
    for (const m of session.markers) expect(m).not.toHaveProperty('symbol');
    expect(byId.b.note).toBe('adding');
  });

  it('is stable: normalizing twice produces the same trades, not duplicates', () => {
    const legacy = {
      id: 'sess_old',
      startedAt: T0,
      markers: [{ id: 'a', offsetMs: 10_000, kind: 'entry', symbol: 'MNQ', direction: 'long', account: '' }],
    };

    const once = normalizeSession(legacy);
    const twice = normalizeSession(once);

    expect(twice.trades).toHaveLength(1);
    expect(twice.trades[0].id).toBe(once.trades[0].id);
    expect(twice.markers[0].tradeId).toBe(once.trades[0].id);
  });

  it('leaves a session already in the new shape untouched', () => {
    const current = {
      id: 'sess_new',
      startedAt: T0,
      trades: [makeTrade({ id: 'tr_1', symbol: 'MNQ', direction: 'long', openedAtMs: 1_000 })],
      markers: [{ id: 'a', offsetMs: 2_000, kind: 'entry', tradeId: 'tr_1', note: '' }],
    };

    const session = normalizeSession(current);
    expect(session.trades).toHaveLength(1);
    expect(session.trades[0].closedAtMs).toBeNull();
    expect(session.markers[0].tradeId).toBe('tr_1');
  });
});
