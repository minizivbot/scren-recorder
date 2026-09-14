/**
 * The trade ticket, rendered identically live and in review.
 *
 * It exists as its own module because a trade reads the same in both places —
 * the pair, the side, the window it ran for — and two copies of that markup
 * would drift until the same trade looked like two different things.
 */
import { el, formatDuration } from './dom.js';

export function sideBadge(direction) {
  return el('span', { class: 'side', dataset: { direction: direction || '' } },
    direction ? direction.toUpperCase() : 'no side');
}

/**
 * @param trade           the trade to render
 * @param markerCount     how many marks are filed under it
 * @param isOpen          still in the position (live) or never closed (review)
 * @param onClick         select / seek to the trade
 * @param actions         extra buttons (review only)
 */
export function tradeRow(trade, { markerCount = 0, isOpen = false, onClick, actions = [] } = {}) {
  const tags = [];
  if (trade.account) {
    tags.push(el('span', { class: `tag${trade.account === 'live' ? ' tag-live' : ''}` }, trade.account));
  }
  if (isOpen) tags.push(el('span', { class: 'tag tag-open' }, 'open'));

  const window = isOpen
    ? `${formatDuration(trade.openedAtMs)} → open`
    : `${formatDuration(trade.openedAtMs)} → ${formatDuration(trade.closedAtMs ?? trade.openedAtMs)}`;

  const meta = [window, `${markerCount} mark${markerCount === 1 ? '' : 's'}`];
  if (!isOpen && trade.closedAtMs != null) {
    meta.push(`held ${formatDuration(Math.max(0, trade.closedAtMs - trade.openedAtMs))}`);
  }

  return el('div', {
    class: 'trade',
    dataset: { direction: trade.direction || '', tradeId: trade.id, open: String(isOpen) },
    ...(onClick ? { onclick: onClick, role: 'button', tabindex: 0, onkeydown: enterActivates(onClick) } : {}),
  },
    el('div', { class: 'trade-id' },
      el('span', { class: `trade-symbol${trade.symbol ? '' : ' is-unset'}` }, trade.symbol || 'No pair set'),
      sideBadge(trade.direction),
      ...tags,
    ),
    actions.length ? el('div', { class: 'trade-actions' }, ...actions) : null,
    el('div', { class: 'trade-meta' }, ...meta.map((t) => el('span', {}, t))),
    trade.note ? el('div', { class: 'marker-note' }, trade.note) : null,
  );
}

function enterActivates(fn) {
  return (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    fn(e);
  };
}
