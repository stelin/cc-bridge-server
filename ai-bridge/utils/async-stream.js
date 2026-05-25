/**
 * AsyncStream - Manually controlled async iterator.
 * Used to pass user messages (including images) to the Claude Agent SDK.
 *
 * Phase 0 (2026-05-23): added a bounded queue with drop-oldest policy so a
 * slow consumer (e.g. a hung supervisor SDK iteration) cannot grow memory
 * unboundedly. When the queue is full, the oldest entry is evicted and a
 * `[STREAM_DROPPED]` diagnostic line is written to stdout (daemon will tag
 * + forward via SSE so the Java side becomes aware of the drop).
 */
export class AsyncStream {
  constructor(maxSize = 200) {
    this.queue = [];
    this.maxSize = maxSize;
    this.dropped = 0;
    this.readResolve = undefined;
    this.isDone = false;
    this.started = false;
  }

  [Symbol.asyncIterator]() {
    if (this.started) {
      throw new Error("Stream can only be iterated once");
    }
    this.started = true;
    return this;
  }

  async next() {
    if (this.queue.length > 0) {
      return { done: false, value: this.queue.shift() };
    }
    if (this.isDone) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve) => {
      this.readResolve = resolve;
    });
  }

  enqueue(value) {
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      resolve({ done: false, value });
      return;
    }
    if (this.queue.length >= this.maxSize) {
      this.queue.shift();
      this.dropped += 1;
      try {
        process.stdout.write(
          `[STREAM_DROPPED] ${JSON.stringify({ count: this.dropped, maxSize: this.maxSize })}\n`
        );
      } catch (_) {
        // stdout may be closed during shutdown; swallow silently.
      }
    }
    this.queue.push(value);
  }

  done() {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  async return() {
    this.isDone = true;
    return { done: true, value: undefined };
  }

  /** Diagnostic: pending queue size. Used by supervisor.health endpoint. */
  size() {
    return this.queue.length;
  }

  /** Diagnostic: cumulative dropped count since construction. */
  droppedCount() {
    return this.dropped;
  }
}
