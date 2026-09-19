import { describe, it, expect } from 'vitest';
import { planDeletions } from '../../scripts/prune-release-assets.mjs';

const KEEP = [
  'TradeJournal-Setup.exe',
  'TradeJournal-Setup.exe.blockmap',
  'TradeJournal-Portable.exe',
  'latest.yml',
];

const assets = (...names) => names.map((name, id) => ({ id, name }));

describe('planDeletions', () => {
  it('removes installers left over from an older naming scheme', () => {
    const { toDelete, problem } = planDeletions(assets(
      'latest.yml',
      'TradeJournal-Portable-1.0.0.exe',
      'TradeJournal-Portable.exe',
      'TradeJournal-Setup-1.0.0.exe',
      'TradeJournal-Setup.exe',
      'TradeJournal-Setup.exe.blockmap',
    ), KEEP);

    expect(problem).toBeNull();
    expect(toDelete.map((a) => a.name)).toEqual([
      'TradeJournal-Portable-1.0.0.exe',
      'TradeJournal-Setup-1.0.0.exe',
    ]);
  });

  it('survives the carriage returns that wiped the release once', () => {
    // The first version of this step compared names built in bash from a
    // Windows pipeline. Every line ended in \r, so no asset matched its own
    // keep-list entry and all six were deleted — the installer included.
    const { toDelete, problem } = planDeletions(assets(
      'latest.yml\r',
      'TradeJournal-Portable-1.0.0.exe\r',
      'TradeJournal-Portable.exe\r',
      'TradeJournal-Setup-1.0.0.exe\r',
      'TradeJournal-Setup.exe\r',
      'TradeJournal-Setup.exe.blockmap\r',
    ), KEEP);

    expect(problem).toBeNull();
    expect(toDelete.map((a) => a.name.trim())).toEqual([
      'TradeJournal-Portable-1.0.0.exe',
      'TradeJournal-Setup-1.0.0.exe',
    ]);
  });

  it('deletes nothing when an expected file is absent', () => {
    // The guard. A keep-list that matches nothing means the list is wrong,
    // not that every asset is garbage.
    const { toDelete, problem } = planDeletions(
      assets('something-else.exe', 'another.exe'), KEEP,
    );
    expect(toDelete).toEqual([]);
    expect(problem).toMatch(/missing from the release/);
    expect(problem).toMatch(/TradeJournal-Setup\.exe/);
  });

  it('refuses when even one expected file is absent', () => {
    // A publish that half-succeeded must not trigger a purge of the rest.
    const { toDelete, problem } = planDeletions(assets(
      'TradeJournal-Setup.exe',
      'TradeJournal-Setup.exe.blockmap',
      'TradeJournal-Portable.exe',
      'TradeJournal-Setup-1.0.0.exe',
      // latest.yml never uploaded
    ), KEEP);
    expect(toDelete).toEqual([]);
    expect(problem).toMatch(/latest\.yml/);
  });

  it('does nothing on a release that is already tidy', () => {
    const { toDelete, problem } = planDeletions(assets(...KEEP), KEEP);
    expect(problem).toBeNull();
    expect(toDelete).toEqual([]);
  });

  it('never treats a name as a pattern', () => {
    // '.' is a regex wildcard; the old grep-based check could match the wrong
    // file. These two differ only where a '.' sits.
    const { toDelete, problem } = planDeletions(assets(
      ...KEEP, 'TradeJournal-SetupXexe',
    ), KEEP);
    expect(problem).toBeNull();
    expect(toDelete.map((a) => a.name)).toEqual(['TradeJournal-SetupXexe']);
  });

  it('refuses an empty keep-list rather than deleting everything', () => {
    const { toDelete, problem } = planDeletions(assets('TradeJournal-Setup.exe'), []);
    expect(toDelete).toEqual([]);
    expect(problem).toMatch(/no keep-list/);
  });

  it('handles a release with no assets at all', () => {
    const { toDelete, problem } = planDeletions([], KEEP);
    expect(toDelete).toEqual([]);
    expect(problem).toMatch(/missing/);
  });
});
