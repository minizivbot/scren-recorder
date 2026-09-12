/**
 * A marker's offset is the whole product. If it drifts, review seeks to the
 * wrong place and the footage might as well not exist.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import {
  SessionRecorder, getSession, seekTargetMs, makeMarker,
  addMarkerToSession, updateSessionMarker, removeSessionMarker, formatOffset,
} from '../../src/session-recorder.js';
import { installBrowserMocks, latestRecorder, flush } from '../helpers/browser-mocks.js';

const T0 = 1_700_000_000_000;

describe('marker offset accuracy', () => {
  let clock;

  beforeEach(async () => {
    await resetDatabase();
    installBrowserMocks();
    clock = T0;
    // Real timers stay real so IndexedDB callbacks still run; only the clock
    // the recorder reads is controlled.
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => vi.restoreAllMocks());

  it('records the offset from recording start, to the millisecond', async () => {
    const rec = new SessionRecorder();
    await rec.start();

    const at = (ms) => { clock = T0 + ms; return rec.mark({ kind: 'entry' }); };

    expect(at(0).offsetMs).toBe(0);
    expect(at(1).offsetMs).toBe(1);
    expect(at(1_500).offsetMs).toBe(1_500);
    expect(at(95_000).offsetMs).toBe(95_000);
    expect(at(2 * 60 * 60 * 1000).offsetMs).toBe(7_200_000);
  });

  it('is unaffected by how many chunks have been written', async () => {
    const rec = new SessionRecorder({ timesliceMs: 2000 });
    await rec.start();
    const mr = latestRecorder();

    // A mark landing between timeslices must not snap to a chunk boundary.
    clock = T0 + 3_500;
    const marker = rec.mark({ symbol: 'MNQ' });
    mr.emit(new Uint8Array([1]));
    mr.emit(new Uint8Array([2]));
    await flush();

    expect(marker.offsetMs).toBe(3_500);
  });

  it('persists markers with their offsets so review can seek after a reload', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();

    clock = T0 + 12_000;
    rec.mark({ kind: 'entry', symbol: 'MES', direction: 'long' });
    clock = T0 + 400_000;
    rec.mark({ kind: 'exit', symbol: 'MES' });
    await flush();
    await rec.stop();

    const session = await getSession(sessionId);
    expect(session.markers.map((m) => m.offsetMs)).toEqual([12_000, 400_000]);
    expect(session.markers[0].symbol).toBe('MES');
    expect(session.markers[1].kind).toBe('exit');
  });

  it('applies the configured pre-roll, clamped at the start of the recording', () => {
    // The setup is the thing being reviewed, so a marker seeks to before itself.
    expect(seekTargetMs({ offsetMs: 300_000 }, 90_000)).toBe(210_000);
    expect(seekTargetMs({ offsetMs: 95_000 }, 90_000)).toBe(5_000);

    // A mark in the first 90 seconds cannot roll back past zero.
    expect(seekTargetMs({ offsetMs: 30_000 }, 90_000)).toBe(0);
    expect(seekTargetMs({ offsetMs: 0 }, 90_000)).toBe(0);

    // Pre-roll is configurable.
    expect(seekTargetMs({ offsetMs: 300_000 }, 0)).toBe(300_000);
    expect(seekTargetMs({ offsetMs: 300_000 }, 30_000)).toBe(270_000);
    expect(seekTargetMs({ offsetMs: 300_000 }, 600_000)).toBe(0);
  });

  it('carries an external trade id field that nothing populates', () => {
    const m = makeMarker({ offsetMs: 10 });
    // The seam for joining an authoritative trade record later. Empty by design.
    expect(m).toHaveProperty('externalTradeId', null);
    expect(m).toHaveProperty('externalSource', null);
    expect(m).not.toHaveProperty('pnl');
  });

  it('adds a marker during review at a scrubbed position and keeps the list sorted', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    clock = T0 + 60_000;
    rec.mark({ kind: 'entry' });
    await flush();
    await rec.stop();

    // The fallback for every marker missed live: scrub to the moment and mark.
    const early = await addMarkerToSession(sessionId, { offsetMs: 15_000, kind: 'note', note: 'missed this' });
    const late = await addMarkerToSession(sessionId, { offsetMs: 120_000, kind: 'exit' });

    const session = await getSession(sessionId);
    expect(session.markers.map((m) => m.offsetMs)).toEqual([15_000, 60_000, 120_000]);
    expect(early.addedDuringReview).toBe(true);
    expect(late.offsetMs).toBe(120_000);
  });

  it('edits and removes markers after recording without touching their offsets', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    clock = T0 + 45_000;
    const m = rec.mark({});
    await flush();
    await rec.stop();

    const edited = await updateSessionMarker(sessionId, m.id, {
      symbol: 'MNQ', direction: 'short', note: 'faded the open', account: 'paper',
    });
    expect(edited.offsetMs).toBe(45_000);
    expect(edited.symbol).toBe('MNQ');
    expect(edited.note).toBe('faded the open');

    expect(await updateSessionMarker(sessionId, 'nope', { note: 'x' })).toBeNull();

    await removeSessionMarker(sessionId, m.id);
    expect((await getSession(sessionId)).markers).toHaveLength(0);
  });

  it('rejects marking when nothing is recording', async () => {
    const rec = new SessionRecorder();
    expect(() => rec.mark({})).toThrow(/Not recording/);
  });

  it('formats offsets for the marker list', () => {
    expect(formatOffset(0)).toBe('00:00');
    expect(formatOffset(65_000)).toBe('01:05');
    expect(formatOffset(3_600_000)).toBe('1:00:00');
    expect(formatOffset(7_325_000)).toBe('2:02:05');
  });
});
