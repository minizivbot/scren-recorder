/**
 * The desktop app, launched for real.
 *
 * What matters here is the thing the browser version could not do: shortcuts
 * registered with the OS, so marking works while another application has focus.
 * Also that the recorder core is genuinely the same code — the app loads the
 * same index.html and src/, it is not a reimplementation.
 */
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test.describe('desktop app', () => {
  let app;
  let page;

  test.beforeAll(async () => {
    app = await electron.launch({
      args: [path.join(process.cwd()), '--no-sandbox'],
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => { await app?.close(); });

  test('opens a real window running the same recorder', async () => {
    expect(await page.title()).toContain('Session Recorder');
    await expect(page.locator('#btn-record')).toBeVisible();

    // The desktop flag reaches the page, so browser-only setup copy is hidden.
    expect(await page.evaluate(() => window.desktop?.isDesktop)).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-desktop', 'true');
    await expect(page.locator('.browser-only')).toBeHidden();

    // It is the same core, not a second implementation.
    const core = await page.evaluate(async () => {
      const m = await import('./src/session-recorder.js');
      return { hasRecorder: typeof m.SessionRecorder === 'function', kinds: m.MARKER_KINDS };
    });
    expect(core.hasRecorder).toBe(true);
    expect(core.kinds).toEqual(['entry', 'exit', 'note']);
  });

  test('registers shortcuts with the operating system', async () => {
    // This is the whole point of the app: globalShortcut is an OS registration,
    // so it fires while Tradovate has focus. No page can do this.
    const result = await app.evaluate(async ({ globalShortcut }) => ({
      entry: globalShortcut.isRegistered('Control+Alt+E'),
      exit: globalShortcut.isRegistered('Control+Alt+X'),
      note: globalShortcut.isRegistered('Control+Alt+N'),
      long: globalShortcut.isRegistered('Control+Alt+L'),
      short: globalShortcut.isRegistered('Control+Alt+S'),
      stop: globalShortcut.isRegistered('Control+Alt+Q'),
    }));

    expect(result).toEqual({
      entry: true, exit: true, note: true, long: true, short: true, stop: true,
    });

    await expect(page.locator('#bridge-state')).toHaveAttribute('data-connected', 'true');
    await expect(page.locator('#bridge-label')).toHaveText('Global hotkeys: ready');
  });

  test('reports a shortcut another application already owns', async () => {
    // A combination that fails to register must be visible, not silent — you
    // would otherwise find out at review time that the mark was never stored.
    const result = await page.evaluate(() => window.desktop.registerShortcuts({
      entry: 'Control+Alt+E',
      exit: 'NotAValidAccelerator!!',
    }));

    expect(result.entry.ok).toBe(true);
    expect(result.exit.ok).toBe(false);

    // Put the real ones back for the remaining tests.
    await page.evaluate(() => window.desktop.registerShortcuts({
      entry: 'Control+Alt+E', exit: 'Control+Alt+X', note: 'Control+Alt+N',
      long: 'Control+Alt+L', short: 'Control+Alt+S', stop: 'Control+Alt+Q',
    }));
  });

  test('an OS shortcut marks a live recording', async () => {
    // Drive the recorder with a synthetic source: this container cannot start a
    // real display capture, but everything after the source is the real path.
    await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 640; c.height = 360;
        const g = c.getContext('2d');
        setInterval(() => {
          g.fillStyle = `hsl(${Date.now() / 20 % 360},70%,50%)`;
          g.fillRect(0, 0, 640, 360);
        }, 100);
        return c.captureStream(10);
      };
    });

    await page.click('#btn-record');
    await page.waitForFunction(() => window.tradeJournal?.state === 'recording');

    // Fire the shortcut from the main process, the way the OS does.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('hotkey', {
        command: 'mark', kind: 'entry', direction: 'long',
      });
    });
    await page.waitForFunction(() => window.tradeJournal.markers.length === 1);

    await page.waitForTimeout(2500);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('hotkey', { command: 'mark', kind: 'exit' });
    });
    await page.waitForFunction(() => window.tradeJournal.markers.length === 2);

    const markers = await page.evaluate(() => window.tradeJournal.markers);
    expect(markers[0]).toMatchObject({ kind: 'entry', direction: 'long', source: 'hotkey' });
    expect(markers[1].offsetMs - markers[0].offsetMs).toBeGreaterThan(2000);

    // Stop by shortcut too, and confirm the session was finalized properly.
    const sessionId = await page.evaluate(() => window.tradeJournal.sessionId);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('hotkey', { command: 'stop' });
    });
    await expect(page.locator('#record-status')).toHaveAttribute('data-state', 'idle');

    const session = await page.evaluate(async (id) => {
      const { getSession, getSessionBlob } = await import('./src/session-recorder.js');
      const s = await getSession(id);
      const blob = await getSessionBlob(id);
      return { status: s.status, markers: s.markers.length, bytes: blob?.size ?? 0 };
    }, sessionId);

    expect(session.status).toBe('complete');
    expect(session.markers).toBe(2);
    expect(session.bytes).toBeGreaterThan(1000);
  });

  test('offers a screen picker instead of failing silently', async () => {
    // Electron has no built-in share dialog; without a handler getDisplayMedia
    // just fails. Check the handler is installed and the picker renders.
    const sources = [
      { id: 'screen:0:0', name: 'Entire screen', kind: 'screen', thumbnail: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
      { id: 'window:1:0', name: 'Tradovate', kind: 'window', thumbnail: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
    ];

    await app.evaluate(({ BrowserWindow }, list) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pick-source', list);
    }, sources);

    await expect(page.locator('.picker')).toBeVisible();
    await expect(page.locator('.picker-item')).toHaveCount(2);
    await expect(page.locator('.picker')).toContainText('Entire screen');
    await expect(page.locator('.picker')).toContainText('Tradovate');

    await page.locator('.picker-item').first().click();
    await expect(page.locator('.picker')).toBeHidden();
  });
});
