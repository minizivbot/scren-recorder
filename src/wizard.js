/**
 * The end-of-session review.
 *
 * Asked right after you stop recording, because that is the only moment you
 * still remember why you did what you did. A day later the reasons have already
 * been rewritten by the outcome.
 *
 * Three steps, all skippable — a journal you cannot skip is a journal you stop
 * opening:
 *   1. How did the day go?  (rating and a note)
 *   2. Did you take any trades?
 *   3. If yes, the details — repeatable for each trade.
 *
 * What gets entered here is the authoritative record. It is not derived from
 * the recording, and the recording is not derived from it; a trade may link to
 * a session so you can jump to the footage, and that is the whole relationship.
 */
import { makeTrade, saveTrade, saveDayReview, getDayReview, dayKey } from './trades.js';
import { el, clear, formatDuration } from './dom.js';
import { formatR } from './stats.js';

const RATING_LABELS = {
  1: 'Rough',
  2: 'Below par',
  3: 'Fine',
  4: 'Good',
  5: 'Excellent',
};

export class SessionWizard {
  constructor({ getPois, onDone }) {
    this.getPois = getPois;
    this.onDone = onDone;
    this.overlay = null;
  }

  /**
   * @param {object} session   the recording just finished, or null when the
   *                           trade form is opened on its own
   * @param {object} existing  a trade being edited, if any
   */
  async open(session, { editTrade = null } = {}) {
    const date = editTrade?.date || (session ? dayKey(session.startedAt) : dayKey());

    this.session = session;
    this.date = date;
    this.savedTrades = [];

    this.overlay = el('div', { class: 'wizard-overlay' });
    document.body.append(this.overlay);

    if (editTrade) {
      await this._tradeStep(editTrade);
    } else if (session) {
      const existingReview = await getDayReview(date);
      await this._dayStep(existingReview);
    } else {
      await this._tradeStep(null);
    }
  }

  close() {
    this.overlay?.remove();
    this.overlay = null;
    this.onDone?.(this.savedTrades);
  }

  _panel(...children) {
    clear(this.overlay).append(el('div', { class: 'wizard' }, ...children));
  }

  // ── step 1: the day ───────────────────────────────────────────────────────

  async _dayStep(existing) {
    let rating = existing?.rating || 0;
    const ratingRow = el('div', { class: 'rating-row' });
    const ratingLabel = el('span', { class: 'rating-label muted' },
      rating ? RATING_LABELS[rating] : 'Not rated');

    const paintStars = () => {
      clear(ratingRow).append(...[1, 2, 3, 4, 5].map((n) => el('button', {
        class: `star-btn${n <= rating ? ' is-on' : ''}`,
        type: 'button',
        'aria-label': `${n} of 5`,
        onclick: () => {
          // Clicking the same star again clears it — a rating you cannot undo
          // is one you will lie with.
          rating = rating === n ? 0 : n;
          ratingLabel.textContent = rating ? RATING_LABELS[rating] : 'Not rated';
          paintStars();
        },
      }, '★')));
    };
    paintStars();

    const note = el('textarea', {
      id: 'day-note',
      rows: 4,
      placeholder: 'How did it go? What did you do well, what would you do differently?',
      value: existing?.note || '',
    });

    this._panel(
      el('div', { class: 'wizard-head' },
        el('span', { class: 'wizard-step' }, 'Step 1 of 2'),
        el('h2', {}, 'How was your day?'),
        this.session ? el('p', { class: 'muted' },
          `Session recorded · ${formatDuration(this.session.durationMs || 0)}`) : null,
      ),
      el('div', { class: 'wizard-body' },
        el('label', { class: 'field-label' }, 'Rating'),
        el('div', { class: 'rating-wrap' }, ratingRow, ratingLabel),
        el('label', { class: 'field-label', for: 'day-note' }, 'Notes'),
        note,
        el('p', { class: 'wizard-hint' },
          'How the day felt is a separate question from how it scored. A disciplined losing day '
          + 'and a lucky winning one should not read the same later.'),
      ),
      el('div', { class: 'wizard-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => this.close() }, 'Skip'),
        el('button', {
          class: 'btn btn-primary', type: 'button', id: 'wizard-next',
          onclick: async () => {
            await saveDayReview({ date: this.date, rating, note: note.value });
            this._askedTradesStep();
          },
        }, 'Next'),
      ),
    );
  }

  // ── step 2: were there trades ─────────────────────────────────────────────

  _askedTradesStep() {
    this._panel(
      el('div', { class: 'wizard-head' },
        el('span', { class: 'wizard-step' }, 'Step 2 of 2'),
        el('h2', {}, 'Did you take any trades?'),
      ),
      el('div', { class: 'wizard-body' },
        el('div', { class: 'choice-row' },
          el('button', {
            class: 'choice', type: 'button', id: 'took-trades',
            onclick: () => this._tradeStep(null),
          },
            el('strong', {}, 'Yes'),
            el('span', { class: 'muted' }, 'Log the details while they are fresh'),
          ),
          el('button', {
            class: 'choice', type: 'button', id: 'no-trades',
            onclick: () => this.close(),
          },
            el('strong', {}, 'No'),
            el('span', { class: 'muted' }, 'Sat on my hands — still worth recording'),
          ),
        ),
      ),
    );
  }

  // ── step 3: the trade ─────────────────────────────────────────────────────

  async _tradeStep(editing) {
    const pois = await this.getPois();
    const selected = new Set(editing?.pois || []);

    const poiRow = el('div', { class: 'poi-row' });
    const paintPois = () => {
      clear(poiRow).append(...(pois.length ? pois.map((poi) => el('button', {
        class: `tag tag-btn${selected.has(poi) ? ' is-on' : ''}`,
        type: 'button',
        onclick: () => {
          if (selected.has(poi)) selected.delete(poi);
          else selected.add(poi);
          paintPois();
        },
      }, poi)) : [
        el('span', { class: 'muted' }, 'No setups defined yet — add them in Settings.'),
      ]));
    };
    paintPois();

    const form = el('form', {
      class: 'trade-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const data = new FormData(form);
        const r = Number(data.get('r'));

        if (!Number.isFinite(r)) {
          form.querySelector('[name="r"]').focus();
          return;
        }

        const trade = makeTrade({
          ...(editing || {}),
          date: this.date,
          sessionId: this.session?.id || editing?.sessionId || null,
          symbol: data.get('symbol'),
          direction: data.get('direction'),
          r,
          pois: [...selected],
          note: data.get('note'),
        });
        if (editing) trade.id = editing.id;

        const saved = await saveTrade(trade);
        this.savedTrades.push(saved);

        if (editing || data.get('andFinish') === '1') this.close();
        else this._savedStep(saved);
      },
    },
      el('div', { class: 'field-grid' },
        el('label', {}, 'Symbol',
          el('input', { name: 'symbol', placeholder: 'MNQ', value: editing?.symbol || '', autofocus: true })),
        el('label', {}, 'Side',
          select('direction', editing?.direction || 'long', [['long', 'Long'], ['short', 'Short']])),
        el('label', {}, 'Result in R',
          el('input', {
            name: 'r', type: 'number', step: '0.01', required: true,
            placeholder: '2 for a 2R win, -1 for a full stop',
            value: editing ? String(editing.r) : '',
          })),
      ),
      el('label', { class: 'field-label' }, 'Why did you take it?'),
      poiRow,
      el('label', { class: 'field-label', for: 'trade-note' }, 'Notes'),
      el('textarea', {
        id: 'trade-note', name: 'note', rows: 3,
        placeholder: 'What did you see? What would you do differently?',
        value: editing?.note || '',
      }),
      el('p', { class: 'wizard-hint' },
        'A negative R is a loss, 0 is breakeven. This is what every statistic is computed from, '
        + 'and it is your own report — nothing is read from the recording.'),
    );

    this._panel(
      el('div', { class: 'wizard-head' },
        el('h2', {}, editing ? 'Edit trade' : 'Trade details'),
      ),
      el('div', { class: 'wizard-body' }, form),
      el('div', { class: 'wizard-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => this.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: () => form.requestSubmit(),
        }, editing ? 'Save' : 'Save trade'),
      ),
    );
  }

  /** After saving: another trade, or done. */
  _savedStep(trade) {
    this._panel(
      el('div', { class: 'wizard-head' },
        el('h2', {}, 'Trade saved'),
        el('p', { class: 'muted' },
          `${trade.symbol || 'Trade'} ${trade.direction} · ${formatR(trade.r)}`),
      ),
      el('div', { class: 'wizard-body' },
        el('div', { class: 'choice-row' },
          el('button', {
            class: 'choice', type: 'button', id: 'add-another',
            onclick: () => this._tradeStep(null),
          },
            el('strong', {}, 'Add another'),
            el('span', { class: 'muted' }, 'More than one trade this session'),
          ),
          el('button', {
            class: 'choice', type: 'button', id: 'wizard-finish',
            onclick: () => this.close(),
          },
            el('strong', {}, 'Done'),
            el('span', { class: 'muted' }, 'That was all of them'),
          ),
        ),
      ),
    );
  }
}

function select(name, value, options) {
  return el('select', { name },
    ...options.map(([v, label]) => el('option', { value: v, selected: value === v }, label)),
  );
}
