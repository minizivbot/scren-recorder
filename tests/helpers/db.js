import { _resetDbForTests } from '../../src/session-recorder.js';

/** Drops the database so each test starts from nothing. */
export async function resetDatabase() {
  _resetDbForTests();
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('trade-journal-recordings');
    req.onsuccess = resolve;
    req.onerror = resolve;
    req.onblocked = resolve;
  });
}
