import type {RadioMessage} from './types';

/**
 * Bounded priority queue with interruption. A higher-priority message cuts the
 * current one; equal or lower priority queues behind it. Both the live queue
 * and the scrollback are capped so a long firefight cannot grow them without
 * bound.
 */
export class RadioSystem {
  queue: RadioMessage[] = [];
  current: RadioMessage | null = null;
  remaining = 0;
  /** Increments on every message that reaches the air, so callers can detect new ones. */
  sequence = 0;
  history: RadioMessage[] = [];

  push(message: RadioMessage) {
    if (this.current?.text === message.text || this.queue.some(m => m.text === message.text)) return;
    if (!this.current || message.priority > this.current.priority) {
      this.current = message;
      this.remaining = message.duration;
      this.sequence++;
      this.history.unshift(message);
      this.history.length = Math.min(6, this.history.length);
    } else {
      this.queue.push(message);
      this.queue.sort((a, b) => b.priority - a.priority);
      this.queue.length = Math.min(8, this.queue.length);
    }
  }

  update(dt: number) {
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.current = null;
      const next = this.queue.shift();
      if (next) this.push(next);
    }
  }

  clear() {this.queue = []; this.current = null; this.remaining = 0; this.history = [];}
}
