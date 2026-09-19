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
import { formatR, formatMoney } from './stats.js';

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
  /**
   * The day's rating and note on their own, for the journal's Edit note button.
   * The same step the end-of-session review opens with, so a note written later
   * is the same thing as one written at the time.
   */
  async openDayReview(date) {
    this.session = null;
    this.date = date;
    this.savedTrades = [];

    this.overlay = el('div', { class: 'wizard-overlay' });
    document.body.append(this.overlay);

    await this._dayStep(await getDayReview(date), { standalone: true });
  }

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

  async _dayStep(existing, { standalone = false } = {}) {
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
        standalone ? null : el('span', { class: 'wizard-step' }, 'Step 1 of 2'),
        el('h2', {}, standalone ? 'How was this day?' : 'How was your day?'),
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
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => this.close() },
          standalone ? 'Cancel' : 'Skip'),
        el('button', {
          class: 'btn btn-primary', type: 'button', id: 'wizard-next',
          onclick: async () => {
            await saveDayReview({ date: this.date, rating, note: note.value });
            if (standalone) this.close();
            else this._askedTradesStep();
          },
        }, standalone ? 'Save' : 'Next'),
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

    // The outcome is picked, and the amounts below take its sign. You type 100
    // on a loss and it is stored as -100 — remembering a minus sign is how a
    // journal ends up with a loss recorded as a win.
    let outcome = editing?.outcome || 'win';

    const outcomeRow = el('div', { class: 'outcome-row' });
    const amountNote = el('p', { class: 'wizard-hint', id: 'amount-note' });

    const paintOutcome = () => {
      clear(outcomeRow).append(...[
        ['win', 'Win', 'Target hit, or closed in profit'],
        ['loss', 'Loss', 'Stopped out, or closed down'],
        ['breakeven', 'Breakeven', 'Scratched — nothing won or lost'],
      ].map(([value, label, sub]) => el('button', {
        class: `outcome-btn${outcome === value ? ' is-on' : ''}`,
        type: 'button',
        dataset: { outcome: value },
        onclick: () => { outcome = value; paintOutcome(); },
      },
        el('strong', {}, label),
        el('span', {}, sub),
      )));

      amountNote.textContent = outcome === 'breakeven'
        // A scratch is rarely exactly nothing: commissions still come off, and
        // getting out a few ticks up is still a breakeven trade.
        ? 'Leave these empty for a clean scratch, or enter what it actually came '
          + 'to — put a minus in front for commissions.'
        : outcome === 'loss'
          ? 'Type what you lost as a plain positive number — it is recorded as a loss.'
          : 'Type what you made as a plain positive number.';
    };

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

        const trade = makeTrade({
          ...(editing || {}),
          date: this.date,
          sessionId: this.session?.id || editing?.sessionId || null,
          symbol: data.get('symbol'),
          direction: data.get('direction'),
          outcome,
          r: data.get('r'),
          pnl: data.get('pnl'),
          pois: [...selected],
          note: data.get('note'),
        });
        if (editing) trade.id = editing.id;

        const saved = await saveTrade(trade);
        this.savedTrades.push(saved);

        if (editing) this.close();
        else this._savedStep(saved);
      },
    },
      el('label', { class: 'field-label' }, 'How did it end?'),
      outcomeRow,

      el('div', { class: 'field-grid amounts' },
        el('label', {}, 'Risk multiple (R)',
          el('input', {
            name: 'r', type: 'number', step: '0.01', inputmode: 'decimal',
            placeholder: '2',
            value: editing?.r ? String(signedForR(editing)) : '',
          })),
        el('label', {}, 'P&L',
          el('input', {
            name: 'pnl', type: 'number', step: '0.01', inputmode: 'decimal',
            placeholder: '250',
            value: editing?.pnl ? String(signedFor(editing)) : '',
          })),
      ),
      amountNote,

      el('div', { class: 'field-grid' },
        el('label', {}, 'Symbol',
          el('input', { name: 'symbol', placeholder: 'MNQ', value: editing?.symbol || '' })),
        el('label', {}, 'Side',
          select('direction', editing?.direction || 'long', [['long', 'Long'], ['short', 'Short']])),
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
        'This is what every statistic is computed from, and it is your own report — '
        + 'nothing is read from the recording.'),
    );

    paintOutcome();

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
          [trade.symbol || 'Trade', trade.direction, formatR(trade.r),
            trade.pnl ? formatMoney(trade.pnl) : null].filter(Boolean).join(' · ')),
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

/**
 * What to put back in the box when editing.
 *
 * Win and loss carry their sign from the outcome, so the box shows the plain
 * magnitude. A breakeven's amount is whatever it actually was, so it is shown
 * as stored — minus sign and all.
 */
function signedFor(trade) {
  return trade.outcome === 'breakeven' ? trade.pnl : Math.abs(trade.pnl);
}

function signedForR(trade) {
  return trade.outcome === 'breakeven' ? trade.r : Math.abs(trade.r);
}

function select(name, value, options) {
  return el('select', { name },
    ...options.map(([v, label]) => el('option', { value: v, selected: value === v }, label)),
  );
}
