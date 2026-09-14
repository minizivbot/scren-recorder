/**
 * SessionRecorder
 *
 * Records one continuous screen-capture session and lets you drop timestamped
 * markers into it while it runs. No clipping, no audio detection.
 *
 * Design notes:
 *  - Chunks are written to IndexedDB as they arrive, so a browser crash or an
 *    accidental refresh costs you at most one timeslice instead of the session.
 *  - Markers store an offset in ms from recording start, so review is just a
 *    seek. Nothing is ever cut.
 *  - There is no audio analysis here on purpose. A fill chime carries one bit of
 *    information and breaks if you mute, play music, or use the desktop app.
 *  - The instrument and the direction belong to a TRADE, not to a marker. You
 *    are long MNQ once, not once per note you take while you are in it. A
 *    session holds trades; markers point at one with tradeId and carry only
 *    what is specific to their own moment.
 *  - A trade can carry an externalTradeId. Nothing in this module ever fills it
 *    in or reads it. It is the seam where an authoritative trade record gets
 *    joined to the footage later. P&L is never inferred from a recording.
 *
 * Browser support: Chrome / Edge / Opera. Firefox works but ignores
 * preferCurrentTab. Safari does not support getDisplayMedia recording reliably.
 */

const DB_NAME = 'trade-journal-recordings';
const DB_VERSION = 1;

/** A session with no chunk written for this long is not being recorded anymore. */
const STALE_AFTER_MS = 15_000;

export const SESSION_STATUS = {
  RECORDING: 'recording',
  COMPLETE: 'complete',
  INTERRUPTED: 'interrupted',
};

export class SessionRecorder {
  constructor(options = {}) {
    this.options = {
      timesliceMs: 2000,
      videoBitsPerSecond: 1_500_000, // 720p-ish; chart text stays readable
      width: 1280,
      height: 720,
      frameRate: 10, // charts are near-static; 10fps cuts size enormously
      ...options,
    };

    this.stream = null;
    this.recorder = null;
    this.sessionId = null;
    this.startedAt = null;
    this.seq = 0;
    this.markers = [];
    this.trades = [];
    this.openTradeId = null;
    this.state = 'idle'; // idle | recording | stopping

    this._listeners = new Map();
    this._db = null;
    this._record = null; // canonical session row; never rebuilt from scratch
    this._pendingWrites = new Set();
    this._stoppedAt = null;
    this._trackEndHandler = null;
    this._quotaHandled = false;
  }

  // ---- tiny event emitter ---------------------------------------------
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners.get(event) || []) {
      try { fn(payload); } catch (err) { console.error(`[recorder:${event}]`, err); }
    }
  }

  // ---- lifecycle --------------------------------------------------------

  static isSupported() {
    return SessionRecorder.support().ok;
  }

  /**
   * Structured support check.
   *
   * Safari is the case worth spelling out: it has getDisplayMedia and it has
   * MediaRecorder, so a feature-detect says yes, and then recording the display
   * stream fails or produces an unplayable file. Better to refuse up front with
   * a real message than to fail oddly two hours into a session.
   */
  static support() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      return { ok: false, reason: 'no-getdisplaymedia', message: 'This browser cannot capture the screen. Use Chrome or Edge.' };
    }
    if (typeof MediaRecorder === 'undefined') {
      return { ok: false, reason: 'no-mediarecorder', message: 'This browser has no MediaRecorder. Use Chrome or Edge.' };
    }
    if (typeof indexedDB === 'undefined') {
      return { ok: false, reason: 'no-indexeddb', message: 'IndexedDB is unavailable (private window?). Recording cannot be stored.' };
    }
    if (isSafari()) {
      return {
        ok: false,
        reason: 'safari',
        message: 'Safari does not reliably support recording a getDisplayMedia stream. Use Chrome or Edge.',
      };
    }
    if (!pickMimeType()) {
      return { ok: false, reason: 'no-codec', message: 'No supported video container for MediaRecorder.' };
    }
    return { ok: true };
  }

  /**
   * Starts one continuous recording.
   *
   * MUST be called directly from a user gesture handler (click/keypress) and
   * must be the first await in that handler — getDisplayMedia rejects if it is
   * reached from a timer or after an unrelated await.
   */
  async start(meta = {}) {
    if (this.state !== 'idle') throw new Error('Already recording');
    const support = SessionRecorder.support();
    if (!support.ok) throw new Error(support.message);

    // Called synchronously from the gesture — nothing may be awaited above this.
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: this.options.frameRate, max: 30 },
        width: { ideal: this.options.width },
        height: { ideal: this.options.height },
      },
      audio: false, // deliberately off — see module header
    });

    const track = this.stream.getVideoTracks()[0];
    if (!track) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
      throw new Error('The capture stream has no video track.');
    }

    // The browser's own "Stop sharing" bar bypasses our UI entirely.
    this._trackEndHandler = () => {
      if (this.state === 'recording') {
        this._emit('source-ended', { sessionId: this.sessionId });
        this.stop().catch((err) => this._emit('error', err));
      }
    };
    track.addEventListener('ended', this._trackEndHandler);

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: this.options.videoBitsPerSecond,
    });

    this.sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.startedAt = Date.now();
    this.seq = 0;
    this.markers = [];
    this.trades = [];
    this.openTradeId = null;
    this._pendingWrites = new Set();
    this._stoppedAt = null;
    this._quotaHandled = false;

    const settings = track.getSettings?.() || {};
    this._record = {
      id: this.sessionId,
      startedAt: this.startedAt,
      endedAt: null,
      mimeType,
      meta,
      markers: [],
      trades: [],
      status: SESSION_STATUS.RECORDING,
      complete: false,
      // Heartbeat: recovery uses this to tell "interrupted" from "another tab is
      // recording right now".
      lastChunkAt: this.startedAt,
      bytes: 0,
      chunkCount: 0,
      options: { ...this.options },
      video: {
        width: settings.width ?? null,
        height: settings.height ?? null,
        frameRate: settings.frameRate ?? null,
      },
    };

    await this._openDb();
    try {
      await this._put('sessions', this._record);
    } catch (err) {
      // If we cannot even write the session row there is no point recording:
      // the chunks would have nowhere to belong.
      track.removeEventListener('ended', this._trackEndHandler);
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
      this.recorder = null;
      this._record = null;
      throw new Error(`Cannot write to storage, refusing to record: ${err?.message || err}`);
    }

    this.recorder.addEventListener('dataavailable', (e) => this._onChunk(e));
    this.recorder.addEventListener('error', (e) => this._emit('error', e.error || e));

    this.recorder.start(this.options.timesliceMs);
    this.state = 'recording';
    this._emit('start', { sessionId: this.sessionId, startedAt: this.startedAt });

    return this.sessionId;
  }

  /**
   * Persists one timeslice.
   *
   * The sequence number is taken synchronously, before any await, so chunks are
   * numbered in the order MediaRecorder emitted them even though the IndexedDB
   * writes complete out of order. Reassembly sorts by seq — a webm stream is
   * only valid in sequence.
   */
  _onChunk(e) {
    if (!e.data || e.data.size === 0) return;
    const seq = this.seq++;
    const atMs = Date.now() - this.startedAt;

    const write = (async () => {
      try {
        await this._put('chunks', {
          key: chunkKey(this.sessionId, seq),
          sessionId: this.sessionId,
          seq,
          atMs,
          size: e.data.size,
          blob: e.data,
        });

        if (this._record) {
          this._record.bytes += e.data.size;
          this._record.chunkCount = Math.max(this._record.chunkCount, seq + 1);
          this._record.lastChunkAt = Date.now();
          // Heartbeat write. Cheap relative to the chunk itself, and it is what
          // makes an interrupted session recoverable with a real duration.
          // Tracked, so stop() cannot write the final record and then have this
          // land afterwards and revert the session to 'recording'.
          this._track(this._put('sessions', { ...this._record }).catch(() => {}));
        }
        this._emit('chunk', { seq, size: e.data.size, atMs });
      } catch (err) {
        // Most likely the origin's storage quota. Better to shout than to
        // silently record into the void.
        console.error('[recorder] failed to persist chunk', err);
        this._emit('error', err);
        if (isQuotaError(err)) this._onQuotaExceeded(err, seq);
      }
    })();

    this._track(write);
  }

  /** Registers a write so _drainWrites() waits for it. */
  _track(promise) {
    this._pendingWrites.add(promise);
    promise.finally(() => this._pendingWrites.delete(promise));
    return promise;
  }

  /**
   * Out of disk. Recording into the void is the worst possible outcome, so this
   * stops the capture rather than carrying on producing chunks that cannot be
   * stored. Everything written before this point stays playable.
   */
  _onQuotaExceeded(err, seq) {
    if (this._quotaHandled) return;
    this._quotaHandled = true;

    if (this._record) this._record.storageError = { kind: 'quota', atSeq: seq, at: Date.now() };
    this._emit('quota-exceeded', { sessionId: this.sessionId, seq, error: err });

    if (this.state === 'recording') {
      this.stop({ reason: 'quota-exceeded' }).catch((e) => this._emit('error', e));
    }
  }

  // ---- trades -----------------------------------------------------------

  /** The trade markers are currently being filed under, if any. */
  get openTrade() {
    return this.trades.find((t) => t.id === this.openTradeId) || null;
  }

  /**
   * Opens a trade. Everything marked from here until closeTrade() belongs to
   * it, which is the whole point: the instrument and the direction are stated
   * once, not re-typed onto every note taken while the position is on.
   *
   * The details can be blank at this moment — pressing the entry hotkey the
   * instant you click buy should never block on typing. Fill them in with
   * updateTrade() while the trade runs, or in review afterwards.
   */
  openNewTrade(data = {}) {
    if (this.state !== 'recording') throw new Error('Not recording');
    if (this.openTradeId) this.closeTrade();

    const trade = makeTrade({ openedAtMs: Date.now() - this.startedAt, ...data });
    this.trades.push(trade);
    this.openTradeId = trade.id;
    this._persistJournal();
    this._emit('trade-opened', trade);
    return trade;
  }

  updateTrade(id, patch) {
    const trade = this.trades.find((t) => t.id === id);
    if (!trade) return null;
    Object.assign(trade, normalizeTradePatch(patch));
    this._persistJournal();
    this._emit('trade-updated', trade);
    return trade;
  }

  closeTrade(id = this.openTradeId) {
    const trade = this.trades.find((t) => t.id === id);
    if (!trade) return null;

    trade.closedAtMs = Date.now() - this.startedAt;
    if (this.openTradeId === trade.id) this.openTradeId = null;
    this._persistJournal();
    this._emit('trade-closed', trade);
    return trade;
  }

  /**
   * Drops a marker at the current point in the recording.
   *
   * It is filed under the open trade automatically, so marking mid-position
   * asks nothing of you. Returns the marker so the caller can attach a note
   * to it later.
   */
  mark(data = {}) {
    if (this.state !== 'recording') throw new Error('Not recording');

    const marker = makeMarker({
      offsetMs: Date.now() - this.startedAt,
      tradeId: this.openTradeId,
      ...data,
    });
    this.markers.push(marker);
    this._persistJournal();
    this._emit('marker', marker);
    return marker;
  }

  updateMarker(id, patch) {
    const m = this.markers.find((x) => x.id === id);
    if (!m) return null;
    Object.assign(m, patch);
    this._persistJournal();
    this._emit('marker-updated', m);
    return m;
  }

  removeMarker(id) {
    this.markers = this.markers.filter((m) => m.id !== id);
    this._persistJournal();
    this._emit('marker-removed', id);
  }

  /** Markers and trades share a session row, so they are written together. */
  _persistJournal() {
    if (!this._record) return;
    this._record.markers = this.markers;
    this._record.trades = this.trades;
    this._track(this._put('sessions', { ...this._record }).catch((err) => {
      this._emit('error', err);
      console.error('[recorder] failed to persist the journal', err);
    }));
  }

  async stop(opts = {}) {
    if (this.state !== 'recording') return null;

    // A position left open when the recording ends is closed at the end of the
    // footage rather than left dangling — there is no more video to be in it.
    if (this.openTradeId) this.closeTrade();

    this.state = 'stopping';
    this._stoppedAt = Date.now();

    // requestData() first: MediaRecorder emits the tail of the current timeslice
    // on stop(), and we want that chunk queued before we start draining.
    await new Promise((resolve) => {
      this.recorder.addEventListener('stop', resolve, { once: true });
      try {
        this.recorder.stop();
      } catch (err) {
        this._emit('error', err);
        resolve();
      }
    });

    const track = this.stream?.getVideoTracks?.()[0];
    if (track && this._trackEndHandler) track.removeEventListener('ended', this._trackEndHandler);
    for (const t of this.stream?.getTracks() || []) t.stop();

    // The final dataavailable fires before 'stop', but its IndexedDB write is
    // still in flight. Marking the session complete before that write lands is
    // how you lose the last timeslice of every session.
    await this._drainWrites();

    this._record.endedAt = this._stoppedAt;
    this._record.durationMs = this._stoppedAt - this._record.startedAt;
    this._record.status = SESSION_STATUS.COMPLETE;
    this._record.complete = true;
    this._record.markers = this.markers;
    this._record.trades = this.trades;
    if (opts.reason) this._record.stopReason = opts.reason;

    const record = { ...this._record };
    await this._put('sessions', record);

    this.state = 'idle';
    this.stream = null;
    this.recorder = null;
    this._record = null;
    this._trackEndHandler = null;

    this._emit('stop', record);
    return record;
  }

  /** Waits for every in-flight chunk/marker write to settle. */
  async _drainWrites() {
    while (this._pendingWrites.size) {
      await Promise.allSettled([...this._pendingWrites]);
    }
  }

  get elapsedMs() {
    if (!this.startedAt) return 0;
    if (this.state === 'recording') return Date.now() - this.startedAt;
    if (this.state === 'stopping') return (this._stoppedAt || Date.now()) - this.startedAt;
    return 0;
  }

  // ---- storage ----------------------------------------------------------

  async _openDb() {
    if (this._db) return this._db;
    this._db = await openDb();
    return this._db;
  }

  async _put(store, value) {
    const db = await this._openDb();
    return put(db, store, value);
  }
}

// ---- trades -------------------------------------------------------------

export const DIRECTIONS = ['long', 'short'];
export const ACCOUNTS = ['paper', 'live'];

/**
 * Trade shape: the instrument, the side, and the account, stated once.
 *
 * Everything here answers "what position was this?", which is true for the
 * whole position and therefore has no business being copied onto each marker
 * inside it.
 *
 * externalTradeId / externalSource are the join seam to an authoritative fill
 * record. They are never populated here. A trade in this app is a label for
 * finding footage — not an accounting record, and no P&L is stored or inferred.
 */
export function makeTrade(data = {}) {
  const { openedAtMs = 0, symbol, direction, account, ...rest } = data;
  return {
    id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    openedAtMs: Math.max(0, Math.round(openedAtMs)),
    closedAtMs: null,
    wallClock: new Date().toISOString(),
    note: '',
    externalTradeId: null,
    externalSource: null,
    ...normalizeTradePatch({ symbol, direction, account }),
    ...rest,
  };
}

/**
 * Instruments are shouted in upper case on every venue, and a select can only
 * ever hand back a known side, so both are normalized on the way in rather
 * than at each of the places that display them.
 */
export function normalizeTradePatch(patch = {}) {
  const out = { ...patch };
  if ('symbol' in patch) out.symbol = String(patch.symbol ?? '').trim().toUpperCase();
  if ('direction' in patch) out.direction = DIRECTIONS.includes(patch.direction) ? patch.direction : '';
  if ('account' in patch) out.account = ACCOUNTS.includes(patch.account) ? patch.account : '';
  if ('note' in patch) out.note = String(patch.note ?? '');
  return out;
}

/** A trade is only worth showing as a ticket once it says what it was. */
export function tradeLabel(trade) {
  if (!trade) return '';
  const side = trade.direction ? trade.direction.toUpperCase() : '';
  return [trade.symbol || 'Unnamed', side].filter(Boolean).join(' ');
}

// ---- markers ------------------------------------------------------------

export const MARKER_KINDS = ['entry', 'exit', 'note'];

/**
 * Marker shape, in one place so live marks and review-time marks cannot drift.
 *
 * A marker holds only what is true of its own moment: when it happened, what
 * kind of moment it was, and anything you want to say about it. What was being
 * traded lives on the trade it points at, so marking mid-position asks nothing
 * of you beyond the keystroke.
 */
export function makeMarker(data = {}) {
  const { offsetMs = 0, ...rest } = data;
  return {
    id: `mk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    offsetMs: Math.max(0, Math.round(offsetMs)),
    wallClock: new Date().toISOString(),
    kind: 'entry', // entry | exit | note
    tradeId: null, // which trade this moment belongs to, if any
    note: '',
    ...rest,
  };
}

/**
 * Where playback should land for a marker.
 *
 * Defaults to pre-roll before the mark, because the setup is the thing being
 * reviewed — by the time the hotkey is pressed the decision has already been
 * made, and that is the part worth watching.
 */
export function seekTargetMs(marker, preRollMs = 90_000) {
  return Math.max(0, (marker?.offsetMs ?? 0) - Math.max(0, preRollMs));
}

// ---- standalone storage helpers (usable without an active recorder) -----

export async function listSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('sessions').objectStore('sessions').getAll();
    req.onsuccess = () => resolve(
      req.result.map(normalizeSession).sort((a, b) => b.startedAt - a.startedAt),
    );
    req.onerror = () => reject(req.error);
  });
}

export async function getSession(sessionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('sessions').objectStore('sessions').get(sessionId);
    req.onsuccess = () => resolve(req.result ? normalizeSession(req.result) : null);
    req.onerror = () => reject(req.error);
  });
}

export async function putSession(session) {
  const db = await openDb();
  return put(db, 'sessions', session);
}

/** Chunk rows without their blobs — for inspection and size accounting. */
export async function listChunkMeta(sessionId) {
  const chunks = await readChunks(sessionId);
  return chunks.map(({ seq, atMs, size }) => ({ seq, atMs, size }));
}

async function readChunks(sessionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = db.transaction('chunks').objectStore('chunks');
    const req = store.getAll(sessionRange(sessionId));
    // Explicit numeric sort. IndexedDB iteration order is not a contract we
    // want to depend on, and a webm stream is only valid in sequence.
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.seq - b.seq));
    req.onerror = () => reject(req.error);
  });
}

/**
 * Reassembles the stored chunks into a single playable Blob.
 * Chunk order matters — a webm stream is only valid in sequence.
 */
export async function getSessionBlob(sessionId) {
  const session = await getSession(sessionId);
  const chunks = await readChunks(sessionId);

  if (chunks.length === 0) return null;
  return new Blob(chunks.map((c) => c.blob), {
    type: session?.mimeType || 'video/webm',
  });
}

/**
 * Deletes the session row AND its chunks, and reports how many bytes went away.
 * Dropping only the row would leave the recording on disk forever.
 */
export async function deleteSession(sessionId) {
  const db = await openDb();
  const meta = await listChunkMeta(sessionId);
  const bytes = meta.reduce((sum, c) => sum + (c.size || 0), 0);

  await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
    tx.objectStore('sessions').delete(sessionId);
    tx.objectStore('chunks').delete(sessionRange(sessionId));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });

  return { sessionId, bytes, chunks: meta.length };
}

/**
 * Marks sessions that were left mid-recording.
 *
 * A refresh or a crash leaves a row with status 'recording' and no one writing
 * to it. The chunks on disk are still a valid prefix of a webm stream, so the
 * session is playable — it just needs an honest duration and a flag.
 *
 * The lastChunkAt heartbeat is what keeps this from stealing a session that
 * another tab is actively recording.
 */
export async function recoverInterruptedSessions({ now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
  const sessions = await listSessions();
  const recovered = [];

  for (const s of sessions) {
    if (s.status !== SESSION_STATUS.RECORDING && s.complete !== false) continue;
    if (s.status === SESSION_STATUS.INTERRUPTED) continue;

    const heartbeat = s.lastChunkAt || s.startedAt;
    if (now - heartbeat < staleAfterMs) continue; // someone is still recording this

    const meta = await listChunkMeta(s.id);
    const last = meta[meta.length - 1];

    const updated = {
      ...s,
      status: SESSION_STATUS.INTERRUPTED,
      complete: false,
      interrupted: true,
      recoveredAt: now,
      // Duration from the last chunk we actually hold, not from wall clock.
      endedAt: last ? s.startedAt + last.atMs : s.startedAt,
      durationMs: last ? last.atMs : 0,
      bytes: meta.reduce((sum, c) => sum + (c.size || 0), 0),
      chunkCount: meta.length,
    };

    await putSession(updated);
    recovered.push(updated);
  }

  return recovered;
}

// ---- marker edits outside a live recording ------------------------------
// Review is where most marker detail gets filled in, and where markers missed
// live get added by scrubbing. None of that has a recorder instance to talk to.

export async function addMarkerToSession(sessionId, data = {}) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`No such session: ${sessionId}`);

  const marker = makeMarker({ addedDuringReview: true, ...data });
  session.markers = sortMarkers([...(session.markers || []), marker]);
  await putSession(session);
  return marker;
}

export async function updateSessionMarker(sessionId, markerId, patch) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`No such session: ${sessionId}`);

  let updated = null;
  session.markers = sortMarkers(
    (session.markers || []).map((m) => (m.id === markerId ? (updated = { ...m, ...patch }) : m)),
  );
  if (!updated) return null;

  await putSession(session);
  return updated;
}

export async function removeSessionMarker(sessionId, markerId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`No such session: ${sessionId}`);

  session.markers = (session.markers || []).filter((m) => m.id !== markerId);
  await putSession(session);
  return session.markers;
}

function sortMarkers(markers) {
  return [...markers].sort((a, b) => a.offsetMs - b.offsetMs);
}

// ---- trade edits outside a live recording -------------------------------

export async function addTradeToSession(sessionId, data = {}) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`No such session: ${sessionId}`);

  const trade = makeTrade({ addedDuringReview: true, ...data });
  session.trades = sortTrades([...(session.trades || []), trade]);
  await putSession(session);
  return trade;
}

export async function updateSessionTrade(sessionId, tradeId, patch) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`No such session: ${sessionId}`);

  let updated = null;
  session.trades = sortTrades(
    (session.trades || []).map((t) => (
      t.id === tradeId ? (updated = { ...t, ...normalizeTradePatch(patch) }) : t
    )),
  );
  if (!updated) return null;

  await putSession(session);
  return updated;
}

/**
 * Deletes a trade. Its markers are kept and unfiled rather than deleted with
 * it — the footage they point at is the expensive thing here, and losing a
 * marked moment because a label was wrong would be a bad trade.
 */
export async function removeSessionTrade(sessionId, tradeId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`No such session: ${sessionId}`);

  session.trades = (session.trades || []).filter((t) => t.id !== tradeId);
  session.markers = (session.markers || []).map((m) => (
    m.tradeId === tradeId ? { ...m, tradeId: null } : m
  ));
  await putSession(session);
  return session.trades;
}

/** Files a marker under a trade (or under none, with a null tradeId). */
export async function assignMarkerToTrade(sessionId, markerId, tradeId) {
  return updateSessionMarker(sessionId, markerId, { tradeId: tradeId || null });
}

function sortTrades(trades) {
  return [...trades].sort((a, b) => a.openedAtMs - b.openedAtMs);
}

/**
 * The trade a moment falls inside, used when a marker is added by scrubbing:
 * if the playhead is inside a position, that is overwhelmingly the position
 * the marker is about.
 */
export function tradeAtOffset(session, offsetMs) {
  const trades = (session?.trades || []).filter((t) => t.openedAtMs <= offsetMs);
  // Latest opener wins, so a trade opened inside another still takes its own marks.
  return trades
    .filter((t) => t.closedAtMs == null || t.closedAtMs >= offsetMs)
    .sort((a, b) => b.openedAtMs - a.openedAtMs)[0] || null;
}

/** Markers filed under each trade, plus the ones filed under none. */
export function groupMarkersByTrade(session) {
  const markers = sortMarkers(session?.markers || []);
  const byTrade = new Map(sortTrades(session?.trades || []).map((t) => [t.id, { trade: t, markers: [] }]));
  const unfiled = [];

  for (const m of markers) {
    const group = m.tradeId ? byTrade.get(m.tradeId) : null;
    if (group) group.markers.push(m);
    else unfiled.push(m);
  }

  return { groups: [...byTrade.values()], unfiled };
}

/**
 * Brings a stored session up to the current shape.
 *
 * Sessions recorded before trades existed carry the instrument and side on
 * every marker. Rather than drop that (it was typed by hand) or keep reading
 * two shapes forever, each distinct instrument/side/account is lifted into one
 * trade and its markers are filed under it. The trade id is derived from those
 * values, so normalizing the same session twice produces the same ids.
 *
 * Pure: it returns a new session and writes nothing. The migrated shape is
 * persisted the next time something saves the session.
 */
export function normalizeSession(session) {
  if (!session) return session;

  const trades = (session.trades || []).map((t) => ({ ...t }));
  const byKey = new Map(trades.map((t) => [legacyTradeKey(t), t]));

  const markers = (session.markers || []).map((marker) => {
    const { symbol, direction, account, ...rest } = marker;
    if (marker.tradeId || !(symbol || direction || account)) {
      // Drops the empty legacy columns; keeps everything else untouched.
      return 'symbol' in marker ? { ...rest, tradeId: marker.tradeId ?? null } : marker;
    }

    const key = legacyTradeKey({ symbol, direction, account });
    let trade = byKey.get(key);
    if (!trade) {
      trade = makeTrade({
        id: `tr_legacy_${key.replace(/[^a-z0-9]+/gi, '-')}`,
        symbol,
        direction,
        account,
        openedAtMs: marker.offsetMs,
        migratedFromMarkers: true,
      });
      byKey.set(key, trade);
      trades.push(trade);
    }

    if (trade.migratedFromMarkers) {
      // A migrated trade ran from its first marked moment to its last; that is
      // the only window the old shape recorded.
      trade.openedAtMs = Math.min(trade.openedAtMs, marker.offsetMs);
      trade.closedAtMs = Math.max(trade.closedAtMs ?? 0, marker.offsetMs);
    }
    return { ...rest, tradeId: trade.id };
  });

  return { ...session, markers: sortMarkers(markers), trades: sortTrades(trades) };
}

function legacyTradeKey({ symbol = '', direction = '', account = '' } = {}) {
  return `${String(symbol).trim().toUpperCase()}|${direction}|${account}`;
}

// ---- storage accounting -------------------------------------------------

/**
 * What the recordings themselves occupy, summed from the session rows.
 *
 * navigator.storage.estimate() is the browser's number and it lags badly: after
 * deleting a session its usage figure does not drop for a long time (IndexedDB
 * compacts later, and the estimate is padded). A meter built only on that would
 * tell you a deletion did nothing. This number is exact and immediate; the
 * browser's estimate is still shown alongside it, because that is the one that
 * governs eviction and quota.
 */
export async function recordingsFootprint() {
  const sessions = await listSessions();
  return {
    bytes: sessions.reduce((sum, s) => sum + (s.bytes || 0), 0),
    sessions: sessions.length,
  };
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota, pct: quota ? (usage / quota) * 100 : 0 };
}

/**
 * Ask the browser not to evict this origin's data under storage pressure.
 * Worth calling once before a long session.
 */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

// ---- internals ----------------------------------------------------------

function chunkKey(sessionId, seq) {
  return `${sessionId}:${String(seq).padStart(9, '0')}`;
}

function sessionRange(sessionId) {
  return IDBKeyRange.bound(`${sessionId}:`, `${sessionId}:\uffff`);
}

function put(db, store, value) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(store, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    const req = tx.objectStore(store).put(value);
    // A quota failure surfaces on the request and then aborts the transaction;
    // whichever arrives first carries the DOMException we need to report.
    req.onerror = () => reject(req.error || tx.error);
    tx.onabort = () => reject(tx.error || req.error || new Error('Transaction aborted'));
    tx.onerror = () => reject(tx.error || req.error);
    tx.oncomplete = () => resolve(value);
  });
}

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { keyPath: 'key' });
        s.createIndex('bySession', 'sessionId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB upgrade blocked by another tab')); };
  });
  return dbPromise;
}

/** Test seam: close and drop the cached connection between test cases. */
export function _resetDbForTests() {
  const pending = dbPromise;
  dbPromise = null;
  pending?.then((db) => db.close()).catch(() => {});
}

export function isQuotaError(err) {
  if (!err) return false;
  const name = err.name || err?.target?.error?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function isSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // Chrome and Edge on macOS both carry "Safari" in the UA string.
  return /Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

export function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export function formatOffset(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
