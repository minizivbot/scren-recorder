import { describe, it, expect } from 'vitest';
import {
  updateSupport, installDecision, compareVersions, shouldCheck, updateMessage,
  STATUS, CHECK_INTERVAL_MS,
} from '../../src/update-policy.js';

describe('updateSupport', () => {
  it('updates an installed Windows build', () => {
    const support = updateSupport({
      packaged: true, platform: 'win32',
      execPath: 'C:\\Users\\ziv\\AppData\\Local\\Programs\\trade-journal\\Trade Journal.exe',
    });
    expect(support.supported).toBe(true);
  });

  it('says why the portable build cannot update itself', () => {
    // It unpacks to a temp folder each run, so there is no install to replace.
    const support = updateSupport({
      packaged: true, platform: 'win32',
      execPath: 'C:\\Downloads\\TradeJournal-Portable.exe',
    });
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/portable/i);
    expect(support.reason).toMatch(/setup/i);
  });

  it('is off when running from source', () => {
    const support = updateSupport({ packaged: false, platform: 'win32', execPath: '/usr/bin/electron' });
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/source/i);
  });

  it('is off where no channel is published', () => {
    const support = updateSupport({ packaged: true, platform: 'linux', execPath: '/opt/tj/tj' });
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/linux/);
  });
});

describe('installDecision', () => {
  it('never installs over a live recording', () => {
    // The installer quits the app to swap the binary. A morning of footage
    // cannot be re-recorded, so the update waits, not the other way round.
    const decision = installDecision({ downloaded: true, recording: true });
    expect(decision.action).toBe('wait');
    expect(decision.reason).toMatch(/recording/i);
  });

  it('still refuses when the user asks for it mid-recording', () => {
    const decision = installDecision({ downloaded: true, recording: true, userAsked: true });
    expect(decision.action).toBe('wait');
  });

  it('installs once recording has stopped', () => {
    expect(installDecision({ downloaded: true, recording: false }).action).toBe('install');
  });

  it('does nothing when there is nothing downloaded', () => {
    expect(installDecision({ downloaded: false, recording: false }).action).toBe('none');
  });
});

describe('compareVersions', () => {
  it('orders build numbers', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('1.0.10', '1.0.10')).toBe(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')).toBe(1);
  });

  it('does not throw on nonsense', () => {
    expect(compareVersions(undefined, null)).toBe(0);
  });
});

describe('shouldCheck', () => {
  it('checks on the first run', () => {
    expect(shouldCheck({ lastCheckAt: 0, now: 1_000, supported: true })).toBe(true);
  });

  it('waits out the interval', () => {
    const now = 10_000_000;
    expect(shouldCheck({ lastCheckAt: now - 1000, now, supported: true })).toBe(false);
    expect(shouldCheck({ lastCheckAt: now - CHECK_INTERVAL_MS, now, supported: true })).toBe(true);
  });

  it('never checks when updates are not supported', () => {
    expect(shouldCheck({ lastCheckAt: 0, now: 1e9, supported: false })).toBe(false);
  });
});

describe('updateMessage', () => {
  it('says an update installs on close, not that it will interrupt', () => {
    const message = updateMessage({ status: STATUS.READY, version: '1.0.12' });
    expect(message).toMatch(/1\.0\.12/);
    expect(message).toMatch(/close/i);
  });

  it('explains the wait during a recording', () => {
    const message = updateMessage({ status: STATUS.WAITING, version: '1.0.12' });
    expect(message).toMatch(/stop recording/i);
  });

  it('shows download progress as a whole number', () => {
    expect(updateMessage({ status: STATUS.DOWNLOADING, version: '1.0.12', percent: 41.7 }))
      .toContain('42%');
  });

  it('surfaces an error rather than hiding it', () => {
    expect(updateMessage({ status: STATUS.ERROR, error: 'getaddrinfo ENOTFOUND' }))
      .toMatch(/ENOTFOUND/);
  });

  it('has nothing to say while idle', () => {
    expect(updateMessage({ status: STATUS.IDLE })).toBeNull();
    expect(updateMessage(undefined)).toBeNull();
  });
});
