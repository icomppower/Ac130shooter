import type {RadioMessage} from './types';

/**
 * Seconds before the same line is allowed on the air again. Without this the
 * scrollback fills with four copies of the same sentence and the ground team
 * sounds like a recording rather than people. It is a time window rather than
 * a blanket ban, so a genuinely new event still gets its callout.
 */
const REPEAT_WINDOW = 26;

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
  /** Local clock, advanced by update, used only for the repeat window. */
  private clock = 0;
  private lastSaid = new Map<string, number>();

  /**
   * Offer a new message. This is the only path the repeat window applies to:
   * a message already waiting in the queue has not been heard yet, and must
   * not be silenced by its own admission record when its turn comes.
   */
  push(message: RadioMessage) {
    if (this.current?.text === message.text) return;
    if (this.queue.some(m => m.text === message.text)) return;
    const said = this.lastSaid.get(message.text);
    if (said !== undefined && this.clock - said < REPEAT_WINDOW) return;
    this.admit(message);
  }

  /** Either interrupt with it or line it up behind what is playing. */
  private admit(message: RadioMessage) {
    if (!this.current || message.priority > this.current.priority) {
      this.air(message);
      return;
    }
    this.queue.push(message);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.queue.length = Math.min(8, this.queue.length);
  }

  /** Put it on the air. The repeat window starts here, not at admission. */
  private air(message: RadioMessage) {
    this.current = message;
    this.remaining = message.duration;
    this.sequence++;
    this.lastSaid.set(message.text, this.clock);
    this.history.unshift(message);
    this.history.length = Math.min(6, this.history.length);
    // Bound the ledger; only recent entries can suppress anything anyway.
    if (this.lastSaid.size > 64) {
      for (const [text, at] of this.lastSaid) {
        if (this.clock - at >= REPEAT_WINDOW) this.lastSaid.delete(text);
      }
    }
  }

  update(dt: number) {
    this.clock += dt;
    this.remaining -= dt;
    if (this.remaining > 0) return;
    this.current = null;
    const next = this.queue.shift();
    if (next) this.admit(next);
  }

  clear() {
    this.queue = [];
    this.current = null;
    this.remaining = 0;
    this.history = [];
    this.lastSaid.clear();
    this.clock = 0;
  }
}
