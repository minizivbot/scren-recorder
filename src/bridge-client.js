/**
 * Subscribes to the local mark bridge.
 *
 * This is what makes marking work while Tradovate has focus. The in-page key
 * handler cannot see those keypresses — no page can — so an OS-level hotkey
 * tool posts to the local server instead and the command arrives here.
 *
 * Connection state is surfaced rather than assumed: a hotkey that silently does
 * nothing is worse than no hotkey, because you only find out at review time
 * that the marker you thought you dropped was never recorded.
 */

export class BridgeClient {
  constructor({ onCommand, onStatus }) {
    this.onCommand = onCommand;
    this.onStatus = onStatus;
    this.source = null;
    this.connected = false;
  }

  connect() {
    if (this.source) return;
    if (typeof EventSource === 'undefined') {
      this._setStatus(false, 'This browser has no EventSource; global hotkeys are unavailable.');
      return;
    }

    this.source = new EventSource('/bridge/events');

    this.source.addEventListener('open', () => this._setStatus(true));

    this.source.addEventListener('message', (e) => {
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return; // keep-alive comments never reach here, but be safe
      }
      this.onCommand?.(payload);
    });

    // EventSource reconnects on its own; report the gap rather than hiding it.
    this.source.addEventListener('error', () => {
      this._setStatus(false, 'Lost contact with the local server — is it still running?');
    });
  }

  disconnect() {
    this.source?.close();
    this.source = null;
    this._setStatus(false);
  }

  _setStatus(connected, message) {
    this.connected = connected;
    this.onStatus?.({ connected, message });
  }
}
