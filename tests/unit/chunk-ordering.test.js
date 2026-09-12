/**
 * A webm stream is only valid in sequence. If reassembly puts the chunks back
 * in the wrong order the file is garbage, and no other test would notice —
 * the bytes are all there, they are just unplayable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import {
  SessionRecorder, getSessionBlob, listChunkMeta, openDb, putSession,
} from '../../src/session-recorder.js';
import {
  installBrowserMocks, latestRecorder, flush, blobBytes,
} from '../helpers/browser-mocks.js';

/** Writes a chunk row directly, bypassing the recorder's key scheme. */
async function putRawChunk(row) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    tx.objectStore('chunks').put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

describe('chunk ordering on reassembly', () => {
  beforeEach(async () => {
    await resetDatabase();
    installBrowserMocks();
  });

  it('reassembles by sequence number, not by IndexedDB key order', async () => {
    const sessionId = 'sess_keyorder';
    await putSession({ id: sessionId, startedAt: 1, mimeType: 'video/webm', markers: [] });

    // Keys whose lexicographic order is the exact reverse of the real sequence.
    // Iterating the store in key order would concatenate these backwards.
    const order = [
      { key: `${sessionId}:z`, seq: 0, byte: 10 },
      { key: `${sessionId}:y`, seq: 1, byte: 11 },
      { key: `${sessionId}:x`, seq: 2, byte: 12 },
      { key: `${sessionId}:w`, seq: 3, byte: 13 },
    ];
    for (const { key, seq, byte } of order) {
      await putRawChunk({
        key, sessionId, seq, atMs: seq * 2000, size: 1,
        blob: new Blob([new Uint8Array([byte])]),
      });
    }

    const bytes = await blobBytes(await getSessionBlob(sessionId));
    expect([...bytes]).toEqual([10, 11, 12, 13]);
  });

  it('keeps 250 chunks in order through a real record cycle', async () => {
    const rec = new SessionRecorder({ timesliceMs: 2000 });
    const sessionId = await rec.start();
    const mr = latestRecorder();

    // Two bytes per chunk lets sequences above 255 stay distinguishable.
    const expected = [];
    for (let i = 0; i < 250; i++) {
      const payload = new Uint8Array([i & 0xff, (i >> 8) & 0xff]);
      expected.push(...payload);
      mr.emit(payload);
    }
    await flush(40);
    await rec.stop();

    const meta = await listChunkMeta(sessionId);
    expect(meta).toHaveLength(250);
    expect(meta.map((c) => c.seq)).toEqual([...Array(250).keys()]);

    const bytes = await blobBytes(await getSessionBlob(sessionId));
    expect([...bytes]).toEqual(expected);
  });

  it('assigns sequence numbers in emission order even when writes settle out of order', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    const mr = latestRecorder();

    const seen = [];
    rec.on('chunk', (c) => seen.push(c.seq));

    // Emitted back-to-back in one synchronous burst: the sequence number has to
    // be taken before the first await or the numbering races the writes.
    for (let i = 0; i < 20; i++) mr.emit(new Uint8Array([i]));
    await flush(20);
    await rec.stop();

    expect(seen.sort((a, b) => a - b)).toEqual([...Array(20).keys()]);
    const bytes = await blobBytes(await getSessionBlob(sessionId));
    expect([...bytes]).toEqual([...Array(20).keys()]);
  });

  it('includes the tail timeslice flushed by stop()', async () => {
    const rec = new SessionRecorder();
    const sessionId = await rec.start();
    const mr = latestRecorder();

    mr.emit(new Uint8Array([1, 1]));
    mr.emit(new Uint8Array([2, 2]));
    await flush();

    // MediaRecorder emits the partial final timeslice on stop(); its write is
    // still in flight when 'stop' fires.
    mr.setTail(new Uint8Array([9, 9]));
    await rec.stop();

    const bytes = await blobBytes(await getSessionBlob(sessionId));
    expect([...bytes]).toEqual([1, 1, 2, 2, 9, 9]);

    const session = await (await import('../../src/session-recorder.js')).getSession(sessionId);
    expect(session.chunkCount).toBe(3);
  });

  it('returns null for a session with no chunks', async () => {
    await putSession({ id: 'empty', startedAt: 1, markers: [] });
    expect(await getSessionBlob('empty')).toBeNull();
  });

  it('does not mix chunks from a neighbouring session', async () => {
    const a = new SessionRecorder();
    const idA = await a.start();
    latestRecorder().emit(new Uint8Array([1]));
    await flush();
    await a.stop();

    const b = new SessionRecorder();
    const idB = await b.start();
    latestRecorder().emit(new Uint8Array([2]));
    await flush();
    await b.stop();

    expect([...(await blobBytes(await getSessionBlob(idA)))]).toEqual([1]);
    expect([...(await blobBytes(await getSessionBlob(idB)))]).toEqual([2]);
  });
});
