/**
 * Review: play a session, seek to markers with pre-roll, edit markers, and add
 * the ones that were missed live by scrubbing to the moment and marking there.
 */
import {
  getSession, getSessionBlob, deleteSession, seekTargetMs,
  addMarkerToSession, updateSessionMarker, removeSessionMarker,
  addTradeToSession, updateSessionTrade, removeSessionTrade,
  tradeAtOffset, tradeLabel,
  SESSION_STATUS, formatBytes,
} from './session-recorder.js';
import { loadSessionIntoVideo, seekTo } from './player.js';
import { tradeRow } from './trade-ui.js';
import { $, el, clear, formatDate, formatClock, formatDuration, confirmDestructive } from './dom.js';

const KIND_LABEL = { entry: 'Entry', exit: 'Exit', note: 'Note' };

export class ReviewView {
  constructor({ onClose, onChanged, getSettings, setSettings }) {
    this.onClose = onClose;
    this.onChanged = onChanged;
    this.getSettings = getSettings;
    this.setSettings = setSettings;

    this.session = null;
    this.objectUrl = null;
    this.durationMs = 0;
    this.editingId = null;
    this.editingTradeId = null;

    this.video = $('#player');
    this.root = $('#view-review');
    this._wire();
  }

  _wire() {
    $('#btn-back').addEventListener('click', () => this.close());
    $('#btn-play').addEventListener('click', () => this._togglePlay());
    $('#btn-back60').addEventListener('click', () => this._nudge(-60));
    $('#btn-back10').addEventListener('click', () => this._nudge(-10));
    $('#btn-fwd10').addEventListener('click', () => this._nudge(10));
    $('#btn-fwd60').addEventListener('click', () => this._nudge(60));
    $('#btn-mark-here').addEventListener('click', () => this._markAtPlayhead());
    $('#btn-add-trade').addEventListener('click', () => this._addTrade());
    $('#btn-delete-session').addEventListener('click', () => this._deleteSession());

    $('#playback-rate').addEventListener('change', (e) => {
      this.video.playbackRate = Number(e.target.value);
    });

    // Pre-roll belongs here as well as in settings: wanting more context is a
    // thought you have while watching, not before.
    $('#review-preroll').addEventListener('change', (e) => {
      const seconds = Math.max(0, Number(e.target.value) || 0);
      this.setSettings?.({ preRollMs: seconds * 1000 });
      this._renderPreRollReadout();
    });

    $('#timeline-track').addEventListener('click', (e) => {
      if (e.target.closest('.tl-marker')) return; // marker clicks seek with pre-roll
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      this._seekSeconds((ratio * this.durationMs) / 1000);
    });

    this.video.addEventListener('timeupdate', () => this._renderProgress());
    this.video.addEventListener('play', () => this._renderPlayButton());
    this.video.addEventListener('pause', () => this._renderPlayButton());
    this.video.addEventListener('seeked', () => this._renderProgress());
  }

  // ---- open / close ------------------------------------------------------

  async open(sessionId) {
    this.session = await getSession(sessionId);
    if (!this.session) return;

    this.root.hidden = false;
    $('#view-record').hidden = true;
    window.scrollTo(0, 0);

    this._renderHeader();
    this._renderMarkers();
    this._renderPreRollReadout();

    const overlay = $('#video-overlay');
    overlay.hidden = false;
    overlay.textContent = 'Loading recording…';

    const blob = await getSessionBlob(sessionId);
    if (!blob) {
      overlay.textContent =
        'This session has no stored video. It was interrupted before the first timeslice was written.';
      this.durationMs = 0;
      return;
    }

    // The stored duration comes from the chunks on disk, so it is right even
    // for an interrupted session the browser cannot measure.
    const { url, durationSeconds } = await loadSessionIntoVideo(this.video, blob, {
      fallbackMs: this.session.durationMs || 0,
    });
    this.objectUrl = url;
    this.durationMs = Math.max(
      Math.round(durationSeconds * 1000) || 0,
      this.session.durationMs || 0,
    );

    overlay.hidden = true;
    $('#time-total').textContent = formatDuration(this.durationMs);
    // Only the rails: they need durationMs to place anything. Re-rendering the
    // lists here would destroy an editor opened while the video was loading,
    // taking whatever had been typed into it with it.
    this._renderTimelineRail();
    this._renderTradeBands();
    this._renderProgress();
  }

  close() {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.objectUrl) {
      // A session blob can be well over a gigabyte. Leaking the URL pins it.
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.session = null;
    this.editingId = null;
    this.editingTradeId = null;
    this.root.hidden = true;
    $('#view-record').hidden = false;
    this.onClose?.();
  }

  // ---- rendering ---------------------------------------------------------

  _renderHeader() {
    const s = this.session;
    $('#review-title').textContent = `${formatDate(s.startedAt)} · ${formatClock(s.startedAt)}`;

    const trades = (s.trades || []).length;
    const markers = (s.markers || []).length;
    const bits = [
      formatDuration(s.durationMs || 0),
      formatBytes(s.bytes || 0),
      `${trades} trade${trades === 1 ? '' : 's'}`,
      `${markers} mark${markers === 1 ? '' : 's'}`,
    ];
    if (s.status === SESSION_STATUS.INTERRUPTED) bits.push('interrupted — recovered');
    if (s.storageError?.kind === 'quota') bits.push('stopped: storage full');
    $('#review-sub').textContent = bits.join(' · ');
  }

  _renderPreRollReadout() {
    $('#review-preroll').value = String(Math.round(this.getSettings().preRollMs / 1000));
  }

  _sortedMarkers() {
    return [...(this.session?.markers || [])].sort((a, b) => a.offsetMs - b.offsetMs);
  }

  _sortedTrades() {
    return [...(this.session?.trades || [])].sort((a, b) => a.openedAtMs - b.openedAtMs);
  }

  _trade(id) {
    return this.session?.trades?.find((t) => t.id === id) || null;
  }

  _renderMarkers() {
    this._renderTradeList();
    this._renderMarkerList();
    this._renderTimelineRail();
    this._renderTradeBands();
  }

  // ---- trades ------------------------------------------------------------

  _renderTradeList() {
    const trades = this._sortedTrades();
    $('#review-trade-count').textContent = String(trades.length);
    $('#review-trade-empty').hidden = trades.length > 0;

    // Same rule as the marker list: never rebuild over a form being typed into.
    const openEditor = this.root.querySelector('[data-trade-editor-for]');
    if (this.editingTradeId && openEditor?.dataset.tradeEditorFor === this.editingTradeId) return;

    const list = clear($('#review-trade-list'));
    for (const trade of trades) list.append(this._tradeCard(trade));
  }

  _tradeCard(trade) {
    if (this.editingTradeId === trade.id) return this._tradeEditor(trade);

    const markerCount = (this.session.markers || []).filter((m) => m.tradeId === trade.id).length;
    return tradeRow(trade, {
      markerCount,
      isOpen: trade.closedAtMs == null,
      onClick: () => this.seekToTrade(trade),
      actions: [
        el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: (e) => {
            e.stopPropagation();
            this.editingTradeId = trade.id;
            this._renderTradeList();
          },
        }, 'Edit'),
        el('button', {
          class: 'btn btn-ghost btn-danger', type: 'button',
          onclick: (e) => { e.stopPropagation(); this._removeTrade(trade); },
        }, 'Delete'),
      ],
    });
  }

  /**
   * The one place the instrument and the side are typed in review — once for
   * the whole trade, however many marks are filed under it.
   */
  _tradeEditor(trade) {
    const form = el('form', {
      class: 'edit-form trade-edit',
      dataset: { tradeEditorFor: trade.id },
      onsubmit: async (e) => {
        e.preventDefault();
        const data = new FormData(form);
        await updateSessionTrade(this.session.id, trade.id, {
          symbol: data.get('symbol'),
          direction: data.get('direction'),
          account: data.get('account'),
          note: data.get('note'),
        });
        this.editingTradeId = null;
        await this._reload();
      },
    },
      el('label', {}, 'Pair',
        el('input', { name: 'symbol', value: trade.symbol || '', placeholder: 'MNQ', spellcheck: false })),
      el('label', {}, 'Side', select('direction', trade.direction, [['', '—'], ['long', 'Long'], ['short', 'Short']])),
      el('label', {}, 'Account', select('account', trade.account, [['', '—'], ['paper', 'Paper'], ['live', 'Live']])),
      el('label', { class: 'full' }, 'Trade note',
        el('textarea', { name: 'note', value: trade.note || '', placeholder: 'What was the setup? Why this trade?' })),
      el('p', { class: 'edit-seam' },
        'A label for finding footage — not an accounting record. No P&L is stored or inferred here.'),
      el('div', { class: 'edit-actions' },
        el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: () => { this.editingTradeId = null; this._renderTradeList(); },
        }, 'Cancel'),
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      ),
    );
    return form;
  }

  _renderTradeBands() {
    const rail = clear($('#timeline-trades'));
    if (this.durationMs <= 0) return;

    for (const trade of this._sortedTrades()) {
      const from = Math.min(100, (trade.openedAtMs / this.durationMs) * 100);
      const to = Math.min(100, ((trade.closedAtMs ?? this.durationMs) / this.durationMs) * 100);
      rail.append(el('button', {
        class: 'tl-trade',
        type: 'button',
        style: `left:${from}%; width:${Math.max(to - from, 0.4)}%`,
        title: `${tradeLabel(trade) || 'Unnamed trade'} · ${formatDuration(trade.openedAtMs)}`,
        dataset: { direction: trade.direction || '', tradeId: trade.id },
        onclick: () => this.seekToTrade(trade),
      }));
    }
  }

  async seekToTrade(trade) {
    // A trade opens where its story starts, so pre-roll applies here too.
    const target = seekTargetMs({ offsetMs: trade.openedAtMs }, this.getSettings().preRollMs);
    await this._seekSeconds(target / 1000);

    for (const node of this.root.querySelectorAll('.trade')) {
      node.classList.toggle('is-active', node.dataset.tradeId === trade.id);
    }
    return target;
  }

  async _addTrade() {
    if (!this.session) return null;
    const trade = await addTradeToSession(this.session.id, {
      openedAtMs: Math.round(this.video.currentTime * 1000),
    });
    this.editingTradeId = trade.id; // straight into the editor: it needs a pair
    await this._reload();
    return trade;
  }

  async _removeTrade(trade) {
    const ok = confirmDestructive(
      `Delete the trade ${tradeLabel(trade) || 'with no pair set'}? Its marks are kept and unfiled.`,
    );
    if (!ok) return;
    await removeSessionTrade(this.session.id, trade.id);
    this.editingTradeId = null;
    await this._reload();
  }

  /** Re-reads the session and repaints everything that depends on it. */
  async _reload() {
    this.session = await getSession(this.session.id);
    this._renderHeader();
    this._renderMarkers();
    this.onChanged?.();
  }

  // ---- markers -----------------------------------------------------------

  _renderMarkerList() {
    const markers = this._sortedMarkers();
    $('#review-marker-count').textContent = String(markers.length);
    $('#review-marker-empty').hidden = markers.length > 0;

    // Never rebuild over a form someone is typing into — but do rebuild when a
    // different marker's editor is being opened.
    const openEditor = this.root.querySelector('[data-editor-for]');
    if (this.editingId && openEditor?.dataset.editorFor === this.editingId) return;

    const list = clear($('#review-marker-list'));
    for (const m of markers) list.append(this._markerRow(m));
  }

  _renderTimelineRail() {
    const rail = clear($('#timeline-markers'));
    if (this.durationMs > 0) {
      for (const m of this._sortedMarkers()) {
        const pct = Math.min(100, (m.offsetMs / this.durationMs) * 100);
        rail.append(el('button', {
          class: 'tl-marker',
          type: 'button',
          style: `left:${pct}%`,
          title: `${KIND_LABEL[m.kind] || m.kind} · ${formatDuration(m.offsetMs)}`,
          dataset: { kind: m.kind },
          onclick: (e) => { e.stopPropagation(); this.seekToMarker(m); },
        }));
      }
    }
    rail.append(el('div', { class: 'tl-playhead', id: 'tl-playhead' }));
  }

  _markerRow(m) {
    if (this.editingId === m.id) return this._markerEditor(m);

    // The pair is shown here, but it is the trade's — this row never owns it.
    const trade = this._trade(m.tradeId);
    const label = [trade
      ? el('span', { class: 'marker-trade' },
        el('strong', {}, trade.symbol || 'No pair set'),
        trade.direction ? ` ${trade.direction}` : '')
      : el('span', { class: 'marker-trade' }, 'unfiled')];

    return el('li', {
      class: 'marker marker-review',
      dataset: { kind: m.kind, markerId: m.id },
      onclick: () => this.seekToMarker(m),
    },
      el('span', { class: 'marker-time' }, formatDuration(m.offsetMs)),
      el('div', { class: 'marker-body' },
        el('div', { class: 'marker-label' },
          el('span', { class: 'marker-kind' }, KIND_LABEL[m.kind] || m.kind),
          ...label,
        ),
        m.note ? el('div', { class: 'marker-note' }, m.note) : null,
      ),
      el('div', { class: 'marker-actions' },
        el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: (e) => { e.stopPropagation(); this.editingId = m.id; this._renderMarkers(); },
        }, 'Edit'),
        el('button', {
          class: 'btn btn-ghost btn-danger', type: 'button',
          onclick: (e) => { e.stopPropagation(); this._removeMarker(m); },
        }, 'Delete'),
      ),
    );
  }

  /**
   * A marker only answers for its own moment: what kind it was, which trade it
   * belongs to, and what you want to say about it. The instrument and the side
   * are edited on the trade, once, however many marks point at it.
   */
  _markerEditor(m) {
    const tradeOptions = [
      ['', 'Unfiled'],
      ...this._sortedTrades().map((t) => [
        t.id,
        `${formatDuration(t.openedAtMs)} · ${tradeLabel(t) || 'no pair set'}`,
      ]),
    ];

    const form = el('form', {
      class: 'edit-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const data = new FormData(form);
        await updateSessionMarker(this.session.id, m.id, {
          kind: data.get('kind'),
          tradeId: data.get('tradeId') || null,
          note: data.get('note').trim(),
        });
        this.editingId = null;
        await this._reload();
      },
    },
      el('label', {}, 'Kind', select('kind', m.kind, [['entry', 'Entry'], ['exit', 'Exit'], ['note', 'Note']])),
      el('label', {}, 'Trade', select('tradeId', m.tradeId, tradeOptions)),
      el('label', { class: 'full' }, 'Note',
        el('textarea', { name: 'note', value: m.note || '', placeholder: 'What did you see at this moment?' })),
      el('p', { class: 'edit-seam' },
        'The pair and the side live on the trade, not here — edit them once on the ticket above.'),
      el('div', { class: 'edit-actions' },
        el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: () => { this.editingId = null; this._renderMarkers(); },
        }, 'Cancel'),
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      ),
    );

    return el('li', { class: 'marker', dataset: { kind: m.kind, editorFor: m.id } },
      el('span', { class: 'marker-time' }, formatDuration(m.offsetMs)),
      el('div', { class: 'marker-body' }, form),
    );
  }

  _renderProgress() {
    const ms = this.video.currentTime * 1000;
    $('#time-current').textContent = formatDuration(ms);

    const pct = this.durationMs > 0 ? Math.min(100, (ms / this.durationMs) * 100) : 0;
    $('#timeline-played').style.width = `${pct}%`;
    const head = $('#tl-playhead');
    if (head) head.style.left = `${pct}%`;
  }

  _renderPlayButton() {
    const btn = $('#btn-play');
    btn.textContent = this.video.paused ? '▶' : '❚❚';
    btn.setAttribute('aria-label', this.video.paused ? 'Play' : 'Pause');
  }

  // ---- transport ---------------------------------------------------------

  /**
   * Lands the configured pre-roll BEFORE the marker. By the time the hotkey was
   * pressed the decision had already been made, so the interesting footage is
   * what came before it.
   */
  async seekToMarker(marker) {
    const target = seekTargetMs(marker, this.getSettings().preRollMs);
    await this._seekSeconds(target / 1000);

    for (const node of this.root.querySelectorAll('.marker')) {
      node.classList.toggle('is-active', node.dataset.markerId === marker.id);
    }
    return target;
  }

  async _seekSeconds(seconds) {
    await seekTo(this.video, seconds);
    this._renderProgress();
  }

  _nudge(seconds) {
    this._seekSeconds(this.video.currentTime + seconds);
  }

  _togglePlay() {
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }

  // ---- marker mutation ---------------------------------------------------

  /** The practical fallback for every marker missed live. */
  async _markAtPlayhead() {
    if (!this.session) return;
    const offsetMs = Math.round(this.video.currentTime * 1000);
    // If the playhead is inside a position, that is what the mark is about —
    // asking would be asking a question the timeline already answers.
    const trade = tradeAtOffset(this.session, offsetMs);
    const marker = await addMarkerToSession(this.session.id, {
      offsetMs,
      kind: 'note',
      tradeId: trade?.id || null,
    });

    this.editingId = marker.id; // open straight into the editor
    await this._reload();
    return marker;
  }

  async _removeMarker(m) {
    if (!confirmDestructive(`Delete the marker at ${formatDuration(m.offsetMs)}?`)) return;
    await removeSessionMarker(this.session.id, m.id);
    await this._reload();
  }

  async _deleteSession() {
    const s = this.session;
    const ok = confirmDestructive(
      `Delete this session and its ${formatBytes(s.bytes || 0)} of video? This cannot be undone.`,
    );
    if (!ok) return;

    const id = s.id;
    this.close();
    await deleteSession(id);
    this.onChanged?.();
  }
}

function select(name, value, options) {
  return el('select', { name },
    ...options.map(([v, label]) => el('option', { value: v, selected: (value || '') === v }, label)),
  );
}
