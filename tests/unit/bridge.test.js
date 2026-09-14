/**
 * The bridge is what makes marking work while Tradovate has focus. If it
 * silently drops a command you only discover it at review time, when the marker
 * you thought you dropped is not there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createBridge, COMMANDS } from '../../scripts/bridge.mjs';

/** A stand-in for the ServerResponse the SSE stream writes to. */
function fakeClient() {
  const frames = [];
  const handlers = {};
  return {
    frames,
    writeHead() {},
    write(chunk) { frames.push(chunk); return true; },
    end() { handlers.close?.(); },
    on(event, fn) { handlers[event] = fn; },
    close() { handlers.close?.(); },
    /** Parsed data: lines, ignoring keep-alive comments. */
    get messages() {
      return frames
        .filter((f) => f.startsWith('data: '))
        .map((f) => JSON.parse(f.slice(6).trim()));
    },
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('mark bridge', () => {
  let bridge;

  beforeEach(() => { bridge = createBridge(); });

  it('delivers a mark to a listening page', () => {
    const client = fakeClient();
    bridge.subscribe(client);

    const result = bridge.handleCommand('{"command":"mark","kind":"entry"}', JSON_HEADERS);

    expect(result.ok).toBe(true);
    expect(result.body.delivered).toBe(1);
    expect(client.messages).toHaveLength(1);
    expect(client.messages[0]).toMatchObject({ command: 'mark', kind: 'entry' });
  });

  it('defaults to an entry mark, which is what a bare hotkey should do', () => {
    const client = fakeClient();
    bridge.subscribe(client);
    bridge.handleCommand('{}', JSON_HEADERS);

    expect(client.messages[0]).toMatchObject({ command: 'mark', kind: 'entry' });
  });

  it('carries symbol, direction and account through to the marker', () => {
    const client = fakeClient();
    bridge.subscribe(client);
    bridge.handleCommand(
      '{"kind":"exit","symbol":"MNQ","direction":"short","account":"live","note":"took half"}',
      JSON_HEADERS,
    );

    expect(client.messages[0]).toMatchObject({
      kind: 'exit', symbol: 'MNQ', direction: 'short', account: 'live', note: 'took half',
    });
  });

  it('reports that nothing is listening, instead of pretending it worked', () => {
    // This is what lets a hotkey say "the recorder tab is not open" rather than
    // appearing to succeed and losing the mark.
    const result = bridge.handleCommand('{"kind":"entry"}', JSON_HEADERS);

    expect(result.ok).toBe(true);
    expect(result.body.delivered).toBe(0);
  });

  it('reaches every open tab', () => {
    const a = fakeClient();
    const b = fakeClient();
    bridge.subscribe(a);
    bridge.subscribe(b);

    expect(bridge.handleCommand('{"kind":"note"}', JSON_HEADERS).body.delivered).toBe(2);
    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(1);
  });

  it('stops delivering to a tab that closed', () => {
    const client = fakeClient();
    bridge.subscribe(client);
    client.close();

    expect(bridge.handleCommand('{"kind":"entry"}', JSON_HEADERS).body.delivered).toBe(0);
  });

  it('accepts a stop command but has no way to start one', () => {
    // getDisplayMedia needs a real gesture in the page, so starting remotely is
    // not something the bridge may pretend to offer.
    expect(COMMANDS.has('stop')).toBe(true);
    expect(COMMANDS.has('start')).toBe(false);

    const client = fakeClient();
    bridge.subscribe(client);
    expect(bridge.handleCommand('{"command":"stop"}', JSON_HEADERS).ok).toBe(true);
    expect(client.messages[0].command).toBe('stop');

    const bad = bridge.handleCommand('{"command":"start"}', JSON_HEADERS);
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(400);
  });

  describe('refuses anything that is not a local hotkey tool', () => {
    it('rejects requests carrying an Origin header', () => {
      // A page on another site cannot inject markers into your journal.
      const result = bridge.handleCommand('{"kind":"entry"}', {
        ...JSON_HEADERS, origin: 'https://evil.example',
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
    });

    it('rejects form-style content types', () => {
      // The content type is the CSRF defence: a cross-origin request cannot set
      // application/json without a preflight, and no CORS headers are served.
      for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data', '']) {
        const result = bridge.handleCommand('{"kind":"entry"}', { 'content-type': type });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(415);
      }
    });

    it('accepts a content type with a charset parameter', () => {
      const result = bridge.handleCommand('{"kind":"entry"}', {
        'content-type': 'application/json; charset=utf-8',
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('rejects malformed commands', () => {
    it('on invalid JSON', () => {
      const result = bridge.handleCommand('{not json', JSON_HEADERS);
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/invalid JSON/);
    });

    it('on a non-object body', () => {
      expect(bridge.handleCommand('"hello"', JSON_HEADERS).status).toBe(400);
      expect(bridge.handleCommand('42', JSON_HEADERS).status).toBe(400);
    });

    it('on an unknown marker kind', () => {
      const result = bridge.handleCommand('{"kind":"lunch"}', JSON_HEADERS);
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/unknown kind/);
    });

    it('by ignoring a direction that is not long or short', () => {
      const client = fakeClient();
      bridge.subscribe(client);
      bridge.handleCommand('{"kind":"entry","direction":"sideways"}', JSON_HEADERS);
      expect(client.messages[0].direction).toBe('');
    });

    it('by truncating an over-long note rather than storing it whole', () => {
      const client = fakeClient();
      bridge.subscribe(client);
      bridge.handleCommand(JSON.stringify({ kind: 'note', note: 'x'.repeat(5000) }), JSON_HEADERS);
      expect(client.messages[0].note).toHaveLength(200);
    });
  });

  it('sends a retry hint so a dropped connection comes back on its own', () => {
    const client = fakeClient();
    bridge.subscribe(client);
    expect(client.frames[0]).toContain('retry:');
  });
});
