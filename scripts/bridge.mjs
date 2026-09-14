/**
 * The mark bridge.
 *
 * The in-page key handler only fires while the tab is focused, which it is not
 * while you are actually trading. This is the way around that: the local server
 * is already running during a session, so anything on the machine that can make
 * an HTTP request — an AutoHotkey script, a Stream Deck, a macro keyboard, a
 * foot pedal — can drop a marker while Tradovate has focus, browser or desktop
 * app alike.
 *
 * The page subscribes to the event stream and marks when a command arrives.
 *
 * Why this and not the two options the README used to list: a browser extension
 * cannot see the Tradovate desktop app, and an Electron wrapper is a whole
 * packaging problem for what is really one HTTP request.
 *
 * Security, for something listening on your own machine:
 *  - The server binds 127.0.0.1 only, so nothing off the machine can reach it.
 *  - Commands must be POST with Content-Type: application/json. A malicious web
 *    page cannot send that cross-origin without a preflight, and no CORS headers
 *    are returned anywhere here, so the preflight fails. That closes the
 *    drive-by case where a site you happen to visit injects markers.
 *  - Any Origin header at all is rejected: real hotkey tools do not send one.
 */

/** Commands the page knows how to act on. */
export const COMMANDS = new Set(['mark', 'stop']);

const KINDS = new Set(['entry', 'exit', 'note']);

export function createBridge() {
  const clients = new Set();
  let lastCommandAt = null;

  function subscribe(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Deliberately no Access-Control-Allow-Origin: only our own page may read
      // this stream.
    });
    res.write('retry: 1000\n\n');

    clients.add(res);
    res.on('close', () => clients.delete(res));

    // A comment line every 20s keeps proxies and idle timeouts from closing a
    // stream that may sit silent for an hour between trades.
    const keepAlive = setInterval(() => {
      if (clients.has(res)) res.write(': keep-alive\n\n');
      else clearInterval(keepAlive);
    }, 20_000);
    keepAlive.unref?.();

    return () => { clients.delete(res); clearInterval(keepAlive); };
  }

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
    return clients.size;
  }

  /**
   * Validates an incoming command. Returns { ok, status, body }.
   * Unknown fields on a mark are passed through, so a hotkey can carry a symbol
   * or direction without this needing to know about them.
   */
  function handleCommand(raw, headers = {}) {
    if (headers.origin) {
      return { ok: false, status: 403, body: { error: 'origin not allowed' } };
    }

    const type = (headers['content-type'] || '').split(';')[0].trim();
    if (type !== 'application/json') {
      return { ok: false, status: 415, body: { error: 'expected Content-Type: application/json' } };
    }

    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    } catch {
      return { ok: false, status: 400, body: { error: 'invalid JSON' } };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, status: 400, body: { error: 'expected a JSON object' } };
    }

    const command = parsed.command || 'mark';
    if (!COMMANDS.has(command)) {
      return { ok: false, status: 400, body: { error: `unknown command: ${command}` } };
    }

    const payload = { command, at: Date.now() };
    if (command === 'mark') {
      const kind = parsed.kind || 'entry';
      if (!KINDS.has(kind)) {
        return { ok: false, status: 400, body: { error: `unknown kind: ${kind}` } };
      }
      Object.assign(payload, {
        kind,
        symbol: str(parsed.symbol),
        direction: parsed.direction === 'long' || parsed.direction === 'short' ? parsed.direction : '',
        account: parsed.account === 'paper' || parsed.account === 'live' ? parsed.account : '',
        note: str(parsed.note),
      });
    }

    lastCommandAt = payload.at;
    const delivered = broadcast(payload);

    // Reporting the listener count is what makes a hotkey script able to say
    // "the page is not open" instead of silently doing nothing.
    return { ok: true, status: 200, body: { ok: true, delivered, command } };
  }

  return {
    subscribe,
    handleCommand,
    get clientCount() { return clients.size; },
    get lastCommandAt() { return lastCommandAt; },
    closeAll() {
      for (const res of clients) { try { res.end(); } catch { /* already gone */ } }
      clients.clear();
    },
  };
}

function str(v) {
  return typeof v === 'string' ? v.trim().slice(0, 200) : '';
}
