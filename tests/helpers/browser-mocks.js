/**
 * Enough of the browser to drive SessionRecorder in Node.
 *
 * Only the capture source and MediaRecorder are faked. IndexedDB is the real
 * (fake-indexeddb) implementation and the Blobs are real Blobs, so chunk
 * persistence, ordering and reassembly are genuinely exercised.
 */
import { vi } from 'vitest';

export class FakeMediaStreamTrack extends EventTarget {
  constructor(settings = {}) {
    super();
    this.kind = 'video';
    this.readyState = 'live';
    this._settings = { width: 1280, height: 720, frameRate: 10, ...settings };
  }
  getSettings() { return { ...this._settings }; }
  stop() { this.readyState = 'ended'; }
  /** Simulates the browser's own "Stop sharing" bar. */
  endFromBrowserUi() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

export class FakeMediaStream {
  constructor(track) { this._track = track ?? new FakeMediaStreamTrack(); }
  getVideoTracks() { return [this._track]; }
  getTracks() { return [this._track]; }
}

/**
 * A MediaRecorder that emits chunks only when the test says so, so tests never
 * depend on wall-clock timing.
 */
export class FakeMediaRecorder extends EventTarget {
  static instances = [];
  static supported = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  static isTypeSupported(type) { return FakeMediaRecorder.supported.includes(type); }

  constructor(stream, options = {}) {
    super();
    this.stream = stream;
    this.mimeType = options.mimeType || 'video/webm';
    this.videoBitsPerSecond = options.videoBitsPerSecond;
    this.state = 'inactive';
    this.timeslice = null;
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; }

  /** Emits one timeslice with deterministic, identifiable bytes. */
  emit(bytes) {
    const data = bytes instanceof Blob ? bytes : new Blob([bytes], { type: this.mimeType });
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data }));
  }

  stop() {
    this.state = 'inactive';
    // Real MediaRecorder flushes the tail timeslice before firing 'stop'.
    if (this._tail) this.emit(this._tail);
    queueMicrotask(() => this.dispatchEvent(new Event('stop')));
  }

  /** Bytes the recorder should flush when stop() is called. */
  setTail(bytes) { this._tail = bytes; }
}

export function installBrowserMocks({ userAgent = 'Chrome/140' } = {}) {
  const track = new FakeMediaStreamTrack();
  const stream = new FakeMediaStream(track);

  FakeMediaRecorder.instances = [];

  globalThis.MediaRecorder = FakeMediaRecorder;

  const getDisplayMedia = vi.fn(async (constraints) => {
    stream._constraints = constraints;
    return stream;
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      userAgent,
      mediaDevices: { getDisplayMedia },
      storage: {
        estimate: async () => ({ usage: 1024, quota: 1024 * 1024 * 1024 }),
        persist: async () => true,
        persisted: async () => false,
      },
    },
  });

  return { track, stream, getDisplayMedia, recorders: FakeMediaRecorder.instances };
}

export function latestRecorder() {
  return FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
}

/** Lets queued microtasks and IndexedDB callbacks settle. */
export async function flush(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

export async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
