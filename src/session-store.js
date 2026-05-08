/**
 * Session metadata persistence.
 *
 * Persists only the bridge contract — sid, projectPath, claudeSid, timestamps —
 * not transient state (child PIDs, hub buffers, subscribers). On startup the
 * server hydrates records into the in-memory map; daemons are not respawned
 * eagerly, the next subscribeSse / writeIn thaws them.
 *
 * Writes are debounced and atomic (write tmp + rename).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from './logger.js';

const FORMAT_VERSION = 1;

export function createSessionStore({ filePath, debounceMs = 200 } = {}) {
  const file = filePath || path.join(os.homedir(), '.cc-bridge', 'sessions.json');
  let getSnapshot = () => ({ version: FORMAT_VERSION, sessions: [] });
  let saveTimer = null;
  let saving = false;
  let pendingWhileSaving = false;

  function setSnapshotProvider(fn) {
    getSnapshot = fn;
  }

  async function load() {
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.sessions)) {
        logger.warn(`session store: malformed file at ${file}, ignoring`);
        return [];
      }
      logger.info(`session store: loaded ${data.sessions.length} record(s) from ${file}`);
      return data.sessions;
    } catch (e) {
      if (e.code === 'ENOENT') {
        logger.info(`session store: no prior state at ${file}`);
        return [];
      }
      logger.warn(`session store: load failed (${e.message}); starting empty`);
      return [];
    }
  }

  function scheduleFlush() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush().catch((e) => logger.warn(`session store: flush rejected: ${e.message}`));
    }, debounceMs);
    saveTimer.unref?.();
  }

  async function flush() {
    if (saving) {
      pendingWhileSaving = true;
      return;
    }
    saving = true;
    try {
      const snapshot = getSnapshot();
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(snapshot, null, 2));
      await fs.promises.rename(tmp, file);
    } catch (e) {
      logger.warn(`session store: write failed (${e.message})`);
    } finally {
      saving = false;
      if (pendingWhileSaving) {
        pendingWhileSaving = false;
        scheduleFlush();
      }
    }
  }

  return { load, scheduleFlush, flush, setSnapshotProvider, filePath: file };
}
