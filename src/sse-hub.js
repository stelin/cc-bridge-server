/**
 * SSE event hub: fan-out events to multiple subscribers, with a ring buffer
 * for `Last-Event-ID` based replay on reconnect.
 */
import { logger } from './logger.js';

export function createSseHub({ bufferSize = 1000, tag = '?' } = {}) {
  const buffer = []; // [{ id, data }]
  let nextId = 1;
  const subscribers = new Set();

  const heartbeat = setInterval(() => {
    for (const res of subscribers) {
      try { res.write(': hb\n\n'); } catch {}
    }
  }, 15_000);
  heartbeat.unref?.();

  function publish(line) {
    const id = nextId++;
    buffer.push({ id, data: line });
    if (buffer.length > bufferSize) buffer.shift();

    let typeStr = '?';
    try {
      const obj = JSON.parse(line);
      typeStr = obj.type || obj.method || obj.event || '?';
    } catch {}
    logger.info(`[push ${tag}] #${id} type=${typeStr} subs=${subscribers.size} bytes=${line.length}`);
    if (logger.isVerbose()) {
      const preview = line.length > 800 ? line.slice(0, 800) + `...(${line.length}b)` : line;
      logger.verbose(`[push ${tag}] #${id} payload=${preview}`);
    }

    for (const res of subscribers) writeEvent(res, id, line);
    return id;
  }

  function attach(res, lastEventId) {
    subscribers.add(res);

    // Tell the subscriber its starting event id (so the heartbeat carries
    // through correctly even before any real event).
    if (lastEventId > 0 && buffer.length > 0 && buffer[0].id > lastEventId + 1) {
      // The requested replay range has already been evicted from the buffer.
      const id = nextId++;
      const errLine = JSON.stringify({
        type: '_ctrl',
        action: 'gateway_error',
        message: 'event buffer exhausted, please create a new session',
        code: 'BUFFER_LOST',
      });
      buffer.push({ id, data: errLine });
      if (buffer.length > bufferSize) buffer.shift();
      writeEvent(res, id, errLine);
      return;
    }

    let replayed = 0;
    for (const { id, data } of buffer) {
      if (id > lastEventId) { writeEvent(res, id, data); replayed++; }
    }
    if (replayed > 0) {
      logger.info(`[push ${tag}] replayed=${replayed} to new subscriber (lastId=${lastEventId})`);
    }
  }

  function detach(res) {
    if (!subscribers.has(res)) return;
    subscribers.delete(res);
    try { res.end(); } catch {}
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of [...subscribers]) detach(res);
  }

  function subscriberCount() {
    return subscribers.size;
  }

  function writeEvent(res, id, data) {
    try {
      // SSE frame: id + event + data, terminated by an empty line.
      // `data` may contain newlines; we serialize one JSON line per event so
      // the daemon's already-line-bound NDJSON maps 1:1 to SSE events.
      res.write(`id: ${id}\nevent: message\ndata: ${data}\n\n`);
    } catch {
      // Broken pipe — drop the subscriber.
      detach(res);
    }
  }

  return { publish, attach, detach, close, subscriberCount };
}
