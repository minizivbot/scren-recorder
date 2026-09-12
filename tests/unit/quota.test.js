/**
 * Running out of storage mid-session must be loud. A recorder that silently
 * drops chunks looks like it is working and produces nothing — the worst
 * possible outcome, and worse than refusing to start.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import {
  SessionRecorder, getSession, getSessionBlob, isQuotaError, storageEstimate,
} from '../../src/session-recorder.js';
import { installBrowserMocks, latestRecorder, flush, blobBytes } from '../helpers/browser-mocks.js';

function quotaError() {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

/**
 * Makes chunk writes start failing after `after` successful ones.
 *
 * `mode: 'throw'` is the synchronous DOMException some builds raise from put();
 * `mode: 'request'` is the asynchronous request error that is more common.
 * The module has to reject on both.
 */
function failChunkWritesAfter(after, mode = 'throw') {
  const realPut = IDBObjectStore.prototype.put;
  let writes = 0;

  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function put(value) {
    if (this.name !== 'chunks') return realPut.call(this, value);
    if (writes++ < after) return realPut.call(this, value);

    if (mode === 'throw') throw quotaError();

    const req = { error: quotaError(), onerror: null, onsuccess: null };
    queueMicrotask(() => req.onerror?.({ target: req }));
    return req;
  });
}

describe('quota exceeded handling', () => {
  beforeEach(async () => {
    await resetDatabase();
    installBrowserMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  for (const mode of ['throw', 'request']) {
    it(`shouts instead of recording into the void (${mode} failure)`, async () => {
      const rec = new SessionRecorder();
      const errors = [];
      const quota = [];
      rec.on('error', (e) => errors.push(e));
      rec.on('quota-exceeded', (e) => quota.push(e));

      const sessionId = await rec.start();
      const mr = latestRecorder();

      failChunkWritesAfter(2, mode);
      mr.emit(new Uint8Array([1]));
      mr.emit(new Uint8Array([2]));
      mr.emit(new Uint8Array([3])); // this one cannot be stored
      await flush(20);

      expect(quota).toHaveLength(1);
      expect(quota[0].sessionId).toBe(sessionId);
      expect(errors.some(isQuotaError)).toBe(true);
    });
  }

  it('stops the capture rather than continuing to produce unstorable chunks', async () => {
    const rec = new SessionRecorder();
    const { track } = installBrowserMocks();
    const sessionId = await rec.start();
    const mr = latestRecorder();

    failChunkWritesAfter(1);
    mr.emit(new Uint8Array([1]));
    mr.emit(new Uint8Array([2]));
    await flush(25);

    expect(rec.state).toBe('idle');
    expect(track.readyState).toBe('ended');

    const session = await getSession(sessionId);
    expect(session.storageError).toMatchObject({ kind: 'quota' });
    expect(session.stopReason).toBe('quota-exceeded');
  });

  it('reports the failure once, not once per dropped chunk', async () => {
    const rec = new SessionRecorder();
    const quota = [];
    rec.on('quota-exceeded', (e) => quota.push(e));
    await rec.start();
    const mr = latestRecorder();

    failChunkWritesAfter(0);
    for (let i = 0; i < 10; i++) mr.emit(new Uint8Array([i]));
    await flush(25);

    expect(quota).toHaveLength(1);
  });

  it('keeps everything written before the failure playable', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    const mr = latestRecorder();

    mr.emit(new Uint8Array([1]));
    mr.emit(new Uint8Array([2]));
    await flush(10);

    failChunkWritesAfter(0);
    mr.emit(new Uint8Array([3]));
    await flush(25);

    // The session is short, not corrupt.
    const bytes = await blobBytes(await getSessionBlob(sessionId));
    expect([...bytes]).toEqual([1, 2]);
  });

  it('refuses to start at all when the session row cannot be written', async () => {
    const { track } = installBrowserMocks();
    const realPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function put(value) {
      if (this.name === 'sessions') throw quotaError();
      return realPut.call(this, value);
    });

    const rec = new SessionRecorder();
    await expect(rec.start()).rejects.toThrow(/Cannot write to storage, refusing to record/);

    // And it gives the screen-share back rather than leaving it running.
    expect(track.readyState).toBe('ended');
    expect(rec.state).toBe('idle');
  });

  it('recognises quota errors in the shapes browsers actually raise', () => {
    expect(isQuotaError(quotaError())).toBe(true);
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ target: { error: { name: 'QuotaExceededError' } } })).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError(new Error('boom'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it('exposes usage so the UI can warn before the quota is hit', async () => {
    const est = await storageEstimate();
    expect(est.usage).toBe(1024);
    expect(est.quota).toBe(1024 * 1024 * 1024);
    expect(est.pct).toBeCloseTo(0.0001, 4);
  });
});
