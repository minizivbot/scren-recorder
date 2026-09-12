/**
 * The browser's own "Stop sharing" bar bypasses the app UI entirely, and
 * deleting a session has to actually free the disk it was using.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import {
  SessionRecorder, SESSION_STATUS, getSession, getSessionBlob, listSessions,
  deleteSession, listChunkMeta, formatBytes,
} from '../../src/session-recorder.js';
import { installBrowserMocks, latestRecorder, flush } from '../helpers/browser-mocks.js';

describe('session lifecycle', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => vi.restoreAllMocks());

  it('finalizes correctly when the capture is ended from the browser bar', async () => {
    const { track } = installBrowserMocks();
    const rec = new SessionRecorder();
    const ended = [];
    rec.on('source-ended', (e) => ended.push(e));

    const sessionId = await rec.start();
    const mr = latestRecorder();
    mr.emit(new Uint8Array([1, 2]));
    await flush();

    // User clicks "Stop sharing" in Chrome's own bar. Our UI never sees a click.
    mr.setTail(new Uint8Array([3]));
    track.endFromBrowserUi();
    await flush(25);

    expect(ended).toHaveLength(1);
    expect(rec.state).toBe('idle');

    const session = await getSession(sessionId);
    expect(session.status).toBe(SESSION_STATUS.COMPLETE);
    expect(session.complete).toBe(true);
    expect(session.endedAt).toBeGreaterThan(0);
    // The tail timeslice still made it in — the file is not truncated.
    expect(session.chunkCount).toBe(2);
    expect(await getSessionBlob(sessionId)).not.toBeNull();
  });

  it('does not double-stop when the bar fires after our own stop', async () => {
    const { track } = installBrowserMocks();
    const rec = new SessionRecorder();
    const stops = [];
    rec.on('stop', (s) => stops.push(s));

    await rec.start();
    latestRecorder().emit(new Uint8Array([1]));
    await flush();
    await rec.stop();

    track.endFromBrowserUi();
    await flush(10);

    expect(stops).toHaveLength(1);
  });

  it('deletes chunks as well as the session row, and reports the bytes freed', async () => {
    installBrowserMocks();
    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    const mr = latestRecorder();

    for (let i = 0; i < 10; i++) mr.emit(new Uint8Array(1000));
    await flush(20);
    await rec.stop();

    expect(await listChunkMeta(sessionId)).toHaveLength(10);

    const freed = await deleteSession(sessionId);
    expect(freed.bytes).toBe(10_000);
    expect(freed.chunks).toBe(10);

    // Both the row and the recording are gone — not just the row.
    expect(await getSession(sessionId)).toBeNull();
    expect(await listChunkMeta(sessionId)).toHaveLength(0);
    expect(await getSessionBlob(sessionId)).toBeNull();
    expect(await listSessions()).toHaveLength(0);
  });

  it('deleting one session leaves its neighbours intact', async () => {
    installBrowserMocks();
    const a = new SessionRecorder();
    const idA = await a.start();
    latestRecorder().emit(new Uint8Array(500));
    await flush();
    await a.stop();

    const b = new SessionRecorder();
    const idB = await b.start();
    latestRecorder().emit(new Uint8Array(700));
    await flush();
    await b.stop();

    await deleteSession(idA);

    expect(await getSession(idA)).toBeNull();
    expect(await listChunkMeta(idB)).toHaveLength(1);
    expect(await getSessionBlob(idB)).not.toBeNull();
  });

  it('refuses to record on Safari instead of failing oddly later', async () => {
    installBrowserMocks({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    });

    const support = SessionRecorder.support();
    expect(support.ok).toBe(false);
    expect(support.reason).toBe('safari');
    expect(support.message).toMatch(/Safari/);

    await expect(new SessionRecorder().start()).rejects.toThrow(/Safari/);
  });

  it('accepts Chrome and Edge, whose user agents also say Safari', () => {
    installBrowserMocks({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
    expect(SessionRecorder.support().ok).toBe(true);

    installBrowserMocks({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0' });
    expect(SessionRecorder.support().ok).toBe(true);
  });

  it('requests capture without audio, deliberately', async () => {
    const { getDisplayMedia } = installBrowserMocks();
    const rec = new SessionRecorder({ width: 1280, height: 720, frameRate: 10 });
    await rec.start();

    const constraints = getDisplayMedia.mock.calls[0][0];
    // A fill chime is one bit of information and breaks the moment you mute.
    expect(constraints.audio).toBe(false);
    expect(constraints.video.frameRate.ideal).toBe(10);
    expect(constraints.video.width.ideal).toBe(1280);
  });

  it('refuses to start twice', async () => {
    installBrowserMocks();
    const rec = new SessionRecorder();
    await rec.start();
    await expect(rec.start()).rejects.toThrow(/Already recording/);
  });

  it('tracks elapsed time only while recording', async () => {
    installBrowserMocks();
    const rec = new SessionRecorder();
    expect(rec.elapsedMs).toBe(0);
    await rec.start();
    expect(rec.elapsedMs).toBeGreaterThanOrEqual(0);
    await rec.stop();
    expect(rec.elapsedMs).toBe(0);
  });

  it('formats byte counts for the storage meter', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1_300_000_000)).toBe('1.2 GB');
  });
});
