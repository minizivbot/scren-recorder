/**
 * App wiring: one continuous recording, markers dropped into it live, and a
 * library for reviewing them afterwards.
 */
import {
  SessionRecorder, SESSION_STATUS, listSessions, recoverInterruptedSessions,
  storageEstimate, recordingsFootprint, requestPersistentStorage, isQuotaError,
  normalizeTradePatch, formatBytes,
} from './session-recorder.js';
import {
  loadSettings, saveSettings, captureOptions, estimateBytesPerHour,
  rememberInstrument, PRESETS,
} from './settings.js';
import { ReviewView } from './review.js';
import { tradeRow, sideBadge } from './trade-ui.js';
import { $, el, clear, formatDate, formatClock, formatDuration } from './dom.js';

const KIND_LABEL = { entry: 'Entry', exit: 'Exit', note: 'Note' };
const KIND_HINT = {
  entry: 'entry — opens a trade if none is open',
  exit: 'exit — closes the open trade',
  note: 'note',
};

let settings = loadSettings();
let recorder = null;
let elapsedTimer = null;
let liveMarkers = [];
let liveTrades = [];

const review = new ReviewView({
  getSettings: () => settings,
  setSettings: (patch) => commitSettings(patch),
  onChanged: () => { renderLibrary(); renderStorage(); },
  onClose: () => { renderLibrary(); renderStorage(); },
});

// ─────────────────────────── recording ───────────────────────────

/**
 * getDisplayMedia must be reached synchronously from the gesture, so this
 * handler awaits nothing before calling start(). Anything that needs doing
 * first (opening the DB, asking for persistent storage) happens at page load.
 */
function onRecordClick() {
  if (recorder && recorder.state === 'recording') {
    stopRecording();
    return;
  }
  startRecording();
}

function startRecording() {
  const support = SessionRecorder.support();
  if (!support.ok) {
    showAlert(support.message);
    return;
  }

  recorder = new SessionRecorder(captureOptions(settings));
  liveMarkers = [];
  liveTrades = [];

  recorder.on('start', () => {
    setRecordingUi(true);
    renderLiveMarkers();
    renderLiveTrades();
    renderTicket();
    startElapsedTimer();
  });

  recorder.on('marker', (m) => {
    liveMarkers = [...liveMarkers, m];
    renderLiveMarkers();
    renderLiveTrades(); // the mark counts on its trade's ticket
  });

  for (const event of ['trade-opened', 'trade-updated', 'trade-closed']) {
    recorder.on(event, () => {
      liveTrades = [...recorder.trades];
      renderLiveTrades();
      renderTicket();
    });
  }

  recorder.on('chunk', () => { /* keeps the storage meter honest during long sessions */ });

  recorder.on('source-ended', () => {
    // The user hit Chrome's own "Stop sharing" bar. The session still finalizes.
    showAlert('Screen sharing was stopped from the browser bar. The session was saved.', 'warn');
  });

  recorder.on('quota-exceeded', () => {
    showAlert(
      'Storage is full. Recording stopped to avoid recording into the void — everything captured '
      + 'before this point was saved. Delete some sessions to free space.',
    );
  });

  recorder.on('error', (err) => {
    if (isQuotaError(err)) return; // already reported, loudly
    console.error('[recorder]', err);
    showAlert(`Recorder error: ${err?.message || err}`, 'warn');
  });

  recorder.on('stop', () => {
    setRecordingUi(false);
    stopElapsedTimer();
    renderTicket();
    renderLibrary();
    renderStorage();
  });

  // Not awaited: the gesture must reach getDisplayMedia synchronously.
  recorder.start({ startedFrom: 'ui' }).catch((err) => {
    recorder = null;
    setRecordingUi(false);
    stopElapsedTimer();
    if (err?.name === 'NotAllowedError') {
      showAlert('Screen capture was declined, so nothing is being recorded.', 'warn');
    } else {
      showAlert(`Could not start recording: ${err?.message || err}`);
    }
  });
}

async function stopRecording() {
  try {
    await recorder?.stop();
  } catch (err) {
    showAlert(`Error while finalizing: ${err?.message || err}`);
  }
}

/**
 * The marking entry point.
 *
 * Deliberately hung off window: a browser extension or a desktop wrapper can
 * call this to mark while another application is focused, which the in-page key
 * handler below fundamentally cannot do.
 */
function mark(data = {}) {
  if (!recorder || recorder.state !== 'recording') return null;
  return recorder.mark(data);
}

/**
 * Opens a trade from whatever the ticket currently says.
 *
 * The ticket may still be blank at this point, and that is the correct
 * behaviour: pressing entry the moment you click buy must never wait on
 * typing. The pair and the side can be filled in while the trade runs, or in
 * review — either way, once.
 */
function openTrade(data = {}) {
  if (!recorder || recorder.state !== 'recording') return null;
  const trade = recorder.openNewTrade({ ...settings.ticket, ...data });
  if (trade.symbol) commitSettings({ instruments: rememberInstrument(settings, trade.symbol) });
  return trade;
}

function closeTrade() {
  if (!recorder || recorder.state !== 'recording') return null;
  const trade = recorder.closeTrade();
  if (!trade) return null;

  // The next ticket starts where this one finished: a session is usually spent
  // on one or two instruments, so the answer is nearly always the same.
  const { symbol, direction, account } = trade;
  commitSettings({
    ticket: { symbol, direction, account },
    instruments: rememberInstrument(settings, symbol),
  });
  return trade;
}

/**
 * The hotkeys speak the language of a position, not of a database row:
 * entry opens one if none is running, exit closes it, and a note simply lands
 * wherever you already are. Nothing here ever asks for the instrument.
 */
function onMarkKey(kind) {
  if (kind === 'entry' && !recorder.openTradeId) openTrade();
  const marker = mark({ kind });
  if (kind === 'exit') closeTrade();
  return marker;
}

function onKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target;
  if (target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
    return;
  }
  if (!recorder || recorder.state !== 'recording') return;

  const key = e.key.toLowerCase();
  const kind = Object.keys(settings.hotkeys).find((k) => settings.hotkeys[k] === key);
  if (!kind) return;

  e.preventDefault();
  onMarkKey(kind);
}

// ─────────────────────────── recording UI ───────────────────────────

function setRecordingUi(isRecording) {
  const btn = $('#btn-record');
  btn.dataset.state = isRecording ? 'recording' : 'idle';
  $('#btn-record-label').textContent = isRecording ? 'Stop recording' : 'Start recording';

  const status = $('#record-status');
  status.dataset.state = isRecording ? 'recording' : 'idle';
  $('#status-text').textContent = isRecording ? 'RECORDING' : 'Not recording';
  $('#desk').dataset.state = isRecording ? 'recording' : 'idle';
  if (!isRecording) {
    $('#elapsed').textContent = '00:00';
    $('#ticket-running-time').textContent = '00:00';
  }
}

function startElapsedTimer() {
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    const elapsedMs = recorder?.elapsedMs || 0;
    $('#elapsed').textContent = formatDuration(elapsedMs);

    const open = recorder?.openTrade;
    if (open) $('#ticket-running-time').textContent = formatDuration(elapsedMs - open.openedAtMs);
  }, 250);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function renderLiveMarkers() {
  $('#live-marker-count').textContent = String(liveMarkers.length);
  $('#live-marker-empty').hidden = liveMarkers.length > 0;

  const list = clear($('#live-marker-list'));
  // Newest first: the mark just dropped is the one being looked at.
  for (const m of [...liveMarkers].reverse()) {
    const trade = liveTrades.find((t) => t.id === m.tradeId);
    list.append(el('li', { class: 'marker', dataset: { kind: m.kind } },
      el('span', { class: 'marker-time' }, formatDuration(m.offsetMs)),
      el('div', { class: 'marker-body' },
        el('div', { class: 'marker-label' },
          el('span', { class: 'marker-kind' }, KIND_LABEL[m.kind] || m.kind),
          // The pair is shown, never asked for: it was stated on the ticket.
          trade
            ? el('span', { class: 'marker-trade' },
              el('strong', {}, trade.symbol || 'No pair set'),
              trade.direction ? ` ${trade.direction}` : '')
            : el('span', { class: 'marker-trade' }, 'no trade open'),
          el('span', { class: 'muted' }, formatClock(Date.parse(m.wallClock))),
        ),
      ),
    ));
  }
}

function renderLiveTrades() {
  $('#live-trade-count').textContent = String(liveTrades.length);
  $('#live-trade-empty').hidden = liveTrades.length > 0;

  const list = clear($('#live-trade-list'));
  for (const trade of [...liveTrades].reverse()) {
    list.append(tradeRow(trade, {
      markerCount: liveMarkers.filter((m) => m.tradeId === trade.id).length,
      isOpen: recorder?.openTradeId === trade.id,
    }));
  }
}

function renderHotkeys() {
  const strip = clear($('#hotkeys-strip'));
  for (const [kind, key] of Object.entries(settings.hotkeys)) {
    strip.append(el('span', { class: 'hotkey', dataset: { kind } },
      el('kbd', {}, key),
      el('span', { class: 'hotkey-what' }, KIND_HINT[kind] || kind)));
  }
}

// ─────────────────────────── the ticket ───────────────────────────
// One form, two jobs: while a trade is open it edits that trade, and while
// none is it holds the ticket the next one will open with. Either way the
// instrument and the side are typed once per trade and never per marker.

/** What the ticket is currently describing. */
function ticketValues() {
  return recorder?.openTrade || settings.ticket;
}

function applyTicket(patch) {
  const open = recorder?.openTrade;
  // Normalized on the way in either way, so the draft and a live trade cannot
  // hold the same instrument in two different spellings.
  if (open) recorder.updateTrade(open.id, patch);
  else commitSettings({ ticket: { ...settings.ticket, ...normalizeTradePatch(patch) } });
  renderTicket();
}

function renderTicket() {
  const open = recorder?.openTrade || null;
  const values = ticketValues();
  const recording = recorder?.state === 'recording';

  const form = $('#ticket');
  form.dataset.open = String(Boolean(open));
  form.dataset.side = values.direction || '';

  const pair = $('#ticket-pair');
  // Never fight the cursor of someone mid-word.
  if (document.activeElement !== pair) pair.value = values.symbol || '';

  for (const [sel, side] of [['#side-long', 'long'], ['#side-short', 'short']]) {
    $(sel).setAttribute('aria-pressed', String(values.direction === side));
  }
  for (const [sel, account] of [['#acct-paper', 'paper'], ['#acct-live', 'live']]) {
    $(sel).setAttribute('aria-pressed', String(values.account === account));
  }

  $('#btn-open-trade').hidden = Boolean(open);
  $('#btn-open-trade').disabled = !recording;
  $('#btn-close-trade').hidden = !open;
  $('#ticket-running').hidden = !open;
  if (open) $('#ticket-running-time').textContent = formatDuration((recorder?.elapsedMs || 0) - open.openedAtMs);

  $('#ticket-hint').textContent = open
    ? 'This trade is running. Every mark lands on it — change the pair or the side here and the '
      + 'whole trade updates, marks included.'
    : recording
      ? 'Set the pair and the side, then open the trade — or just hit the entry hotkey and fill '
        + 'them in while it runs. Either way you state them once.'
      : 'Set up the ticket now if you like. A trade can only be opened while recording.';

  const list = clear($('#instrument-list'));
  for (const symbol of settings.instruments) list.append(el('option', { value: symbol }));
}

function wireTicket() {
  // A form around the ticket keeps Enter from doing nothing useful; it must not
  // navigate.
  $('#ticket').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!recorder?.openTradeId) $('#btn-open-trade').click();
  });

  $('#ticket-pair').addEventListener('input', (e) => {
    applyTicket({ symbol: e.target.value });
  });

  for (const [sel, direction] of [['#side-long', 'long'], ['#side-short', 'short']]) {
    $(sel).addEventListener('click', () => {
      // Clicking the pressed side clears it, so a mis-click is one click to undo.
      applyTicket({ direction: ticketValues().direction === direction ? '' : direction });
    });
  }

  for (const [sel, account] of [['#acct-paper', 'paper'], ['#acct-live', 'live']]) {
    $(sel).addEventListener('click', () => {
      applyTicket({ account: ticketValues().account === account ? '' : account });
    });
  }

  $('#btn-open-trade').addEventListener('click', () => {
    if (!openTrade()) showAlert('Start recording before opening a trade.', 'warn');
  });

  $('#btn-close-trade').addEventListener('click', () => closeTrade());
}

// ─────────────────────────── library ───────────────────────────

async function renderLibrary() {
  const sessions = await listSessions();
  $('#session-count').textContent = String(sessions.length);
  $('#session-empty').hidden = sessions.length > 0;

  const list = clear($('#session-list'));
  for (const s of sessions) list.append(sessionRow(s));
}

function sessionRow(s) {
  const markers = (s.markers || []).length;
  const trades = s.trades || [];
  const badges = [];
  if (s.status === SESSION_STATUS.INTERRUPTED) {
    badges.push(el('span', { class: 'badge badge-interrupted', title: 'Recovered after a refresh or crash — playable up to the last stored timeslice' }, 'interrupted'));
  }
  if (s.status === SESSION_STATUS.RECORDING) {
    badges.push(el('span', { class: 'badge badge-recording' }, 'recording'));
  }
  if (s.storageError?.kind === 'quota') {
    badges.push(el('span', { class: 'badge badge-quota' }, 'storage full'));
  }

  return el('button', {
    class: 'session', type: 'button', dataset: { sessionId: s.id },
    onclick: () => review.open(s.id),
  },
    el('div', { class: 'session-when' },
      el('div', { class: 'session-date' }, formatDate(s.startedAt)),
      el('div', { class: 'session-time' }, formatClock(s.startedAt)),
    ),
    // What was traded is the line you scan a journal by, so it leads.
    el('div', { class: 'session-instruments' },
      ...trades.map((t) => el('span', { class: 'trade-id' },
        el('span', { class: `trade-symbol${t.symbol ? '' : ' is-unset'}` }, t.symbol || '—'),
        sideBadge(t.direction),
      )),
      ...badges,
      trades.length ? null : el('span', { class: 'empty' }, 'no trades logged'),
    ),
    el('div', { class: 'session-stats' },
      stat(formatDuration(s.durationMs || 0), 'length'),
      stat(String(trades.length), trades.length === 1 ? 'trade' : 'trades'),
      stat(String(markers), markers === 1 ? 'mark' : 'marks'),
      stat(formatBytes(s.bytes || 0), 'size'),
    ),
  );
}

function stat(value, label) {
  return el('div', { class: 'stat' },
    el('span', { class: 'stat-value' }, value),
    el('span', { class: 'stat-label' }, label),
  );
}

// ─────────────────────────── storage meter ───────────────────────────

let wasStorageLow = false;

async function renderStorage() {
  const [est, own] = await Promise.all([storageEstimate(), recordingsFootprint()]);
  const fill = $('#storage-fill');
  const text = $('#storage-text');

  // Our own total, which is exact and drops the moment a session is deleted.
  const mine = `${formatBytes(own.bytes)} in ${own.sessions} session${own.sessions === 1 ? '' : 's'}`;

  if (!est) {
    text.textContent = mine;
    return;
  }

  // The bar tracks the browser's quota, since that is what causes eviction.
  fill.style.width = `${Math.min(100, est.pct)}%`;
  fill.dataset.level = est.pct > 90 ? 'danger' : est.pct > 75 ? 'warn' : 'ok';
  text.textContent = mine;
  $('#storage-meter').title =
    `Recordings: ${mine}\nBrowser reports ${formatBytes(est.usage)} of ${formatBytes(est.quota)} used for this site.\n`
    + 'The browser\'s figure lags after a delete; the recordings total is exact.';

  // Only when it crosses, not on every poll — a banner every 15 seconds trains
  // you to ignore banners.
  const low = est.pct > 90;
  if (low && !wasStorageLow) {
    showAlert('Storage is over 90% full. Delete some sessions before recording again.', 'warn');
  }
  wasStorageLow = low;
}

// ─────────────────────────── settings ───────────────────────────

function renderSettings() {
  $('#set-preroll').value = String(Math.round(settings.preRollMs / 1000));
  $('#set-width').value = String(settings.width);
  $('#set-height').value = String(settings.height);
  $('#set-fps').value = String(settings.frameRate);
  $('#set-bitrate').value = String(Math.round(settings.videoBitsPerSecond / 1000));
  $('#set-key-entry').value = settings.hotkeys.entry;
  $('#set-key-exit').value = settings.hotkeys.exit;
  $('#set-key-note').value = settings.hotkeys.note;

  const presets = clear($('#set-preset'));
  presets.append(el('option', { value: '' }, 'Custom'));
  PRESETS.forEach((p, i) => {
    const matches = p.width === settings.width && p.height === settings.height
      && p.frameRate === settings.frameRate && p.videoBitsPerSecond === settings.videoBitsPerSecond;
    presets.append(el('option', { value: String(i), selected: matches }, p.label));
  });

  const perHour = estimateBytesPerHour(settings);
  $('#size-estimate').textContent =
    `About ${formatBytes(perHour)} per hour — roughly ${formatBytes(perHour * 2)} for a two-hour session.`;

  renderHotkeys();
}

function commitSettings(patch) {
  settings = saveSettings({ ...settings, ...patch });
  renderSettings();
  // The ticket draft lives in settings, so it re-reads whenever they change.
  renderTicket();
}

function wireSettings() {
  $('#nav-settings').addEventListener('click', (e) => {
    const panel = $('#settings-panel');
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
  });

  $('#set-preroll').addEventListener('change', (e) => {
    commitSettings({ preRollMs: Math.max(0, Number(e.target.value) || 0) * 1000 });
  });

  $('#set-preset').addEventListener('change', (e) => {
    const preset = PRESETS[Number(e.target.value)];
    if (!preset) return;
    const { label, ...values } = preset;
    commitSettings(values);
  });

  const numeric = [
    ['#set-width', 'width', 1],
    ['#set-height', 'height', 1],
    ['#set-fps', 'frameRate', 1],
    ['#set-bitrate', 'videoBitsPerSecond', 1000],
  ];
  for (const [sel, key, scale] of numeric) {
    $(sel).addEventListener('change', (e) => {
      const value = Math.max(1, Number(e.target.value) || 0) * scale;
      commitSettings({ [key]: value });
    });
  }

  for (const [sel, kind] of [['#set-key-entry', 'entry'], ['#set-key-exit', 'exit'], ['#set-key-note', 'note']]) {
    $(sel).addEventListener('change', (e) => {
      const key = (e.target.value || '').toLowerCase().slice(0, 1);
      if (!key) { renderSettings(); return; }
      commitSettings({ hotkeys: { ...settings.hotkeys, [kind]: key } });
    });
  }

  $('#btn-persist').addEventListener('click', async () => {
    const granted = await requestPersistentStorage();
    $('#persist-state').textContent = granted
      ? 'Granted — recordings will not be evicted.'
      : 'Denied. The browser may evict recordings under storage pressure.';
  });
}

/**
 * Asks for persistent storage up front rather than behind a button, so a long
 * session is not recording into data the browser considers evictable.
 *
 * Chromium grants this silently from engagement heuristics. Firefox prompts, and
 * a permission prompt on page load is obnoxious, so there it stays manual.
 */
async function ensurePersistentStorage() {
  if (!navigator.storage?.persisted) return;

  const state = $('#persist-state');
  if (await navigator.storage.persisted()) {
    state.textContent = 'Granted — recordings will not be evicted.';
    return;
  }

  const isChromium = /Chrome|Chromium|Edg\//.test(navigator.userAgent);
  if (!isChromium) {
    state.textContent = 'Not granted. Request it before a long session.';
    return;
  }

  const granted = await requestPersistentStorage().catch(() => false);
  state.textContent = granted
    ? 'Granted — recordings will not be evicted.'
    : 'Not granted. The browser may evict recordings under storage pressure.';
}

// ─────────────────────────── banners ───────────────────────────

let alertTimer = null;

function showAlert(message, level = 'error') {
  const banner = $('#alert-banner');
  banner.hidden = false;
  banner.className = `banner banner-${level === 'warn' ? 'warn' : 'error'}`;
  banner.textContent = message;

  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => { banner.hidden = true; }, 12_000);
}

function renderSupport() {
  const support = SessionRecorder.support();
  if (support.ok) return true;

  const banner = $('#support-banner');
  banner.hidden = false;
  banner.append(
    el('strong', {}, 'Recording is not available in this browser.'),
    document.createTextNode(support.message),
  );
  $('#btn-record').disabled = true;
  return false;
}

// ─────────────────────────── boot ───────────────────────────

async function boot() {
  wireSettings();
  wireTicket();
  renderSettings();
  renderTicket();
  $('#btn-record').addEventListener('click', onRecordClick);
  window.addEventListener('keydown', onKeyDown);

  window.addEventListener('beforeunload', (e) => {
    if (recorder?.state === 'recording') {
      // Leaving mid-session is recoverable, but costs the buffered timeslice.
      e.preventDefault();
      e.returnValue = '';
    }
  });

  renderSupport();

  // Anything that would delay the record gesture happens here, not in the click.
  const recovered = await recoverInterruptedSessions();
  if (recovered.length) {
    showAlert(
      `${recovered.length} session${recovered.length === 1 ? ' was' : 's were'} interrupted by a refresh or crash. `
      + 'Recovered and playable up to the last stored timeslice.',
      'warn',
    );
  }

  await ensurePersistentStorage();

  await renderLibrary();
  await renderStorage();
  setInterval(renderStorage, 15_000);
}

// The external marking seam, and enough state for a wrapper to drive the app.
window.tradeJournal = {
  mark,
  openTrade,
  closeTrade,
  start: startRecording,
  stop: stopRecording,
  get state() { return recorder?.state || 'idle'; },
  get sessionId() { return recorder?.sessionId || null; },
  get markers() { return [...liveMarkers]; },
  get trades() { return [...liveTrades]; },
  get currentTrade() { return recorder?.openTrade || null; },
  review,
  get settings() { return { ...settings }; },
};

boot().catch((err) => {
  console.error(err);
  showAlert(`Startup failed: ${err?.message || err}`);
});
