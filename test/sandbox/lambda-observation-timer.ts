/**
 * v2 ticket 10: the wait between two observations of a Lambda boot, moved by the test (never a real wait). `tick()` lets ONE interval
 * elapse and returns once the watch either waits again or reported the end of the environment (the test calls `settled()` from the
 * `environmentEnded` callback it gives the adapter).
 */
export function manualObservationTimer(advance: (milliseconds: number) => void = () => {}) {
  const waits: { milliseconds: number; resolve(): void; done: boolean }[] = [];
  const asked: number[] = [];
  let progressed: (() => void) | null = null;
  let arrived: (() => void) | null = null;
  const pending = () => waits.filter(wait => !wait.done);
  let over = false;
  const progress = () => { const resolve = progressed; progressed = null; resolve?.(); };
  /** A watch that reported the end waits no more: asking it for another interval is a test error, never a hang. */
  const next = async () => {
    if (pending().length === 0 && over) throw new Error('The watch is over: no interval is pending');
    if (pending().length === 0) await new Promise<void>(resolve => { arrived = resolve; });
    return pending()[0]!;
  };
  const timer = (milliseconds: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const wait = { milliseconds, done: false, resolve: () => { if (!wait.done) { wait.done = true; resolve(); } } };
    if (signal.aborted) { resolve(); return; }
    waits.push(wait);
    asked.push(milliseconds);
    signal.addEventListener('abort', () => wait.resolve(), { once: true });
    const notify = arrived; arrived = null; notify?.();
    progress();
  });
  return { timer,
    /** Every interval the watch asked for, in order. */
    intervals: () => [...asked],
    pending: () => pending().length,
    /** Called by the test when the adapter reported the end: a `tick()` in progress returns. */
    settled() { over = true; progress(); },
    /** Resolves once a watch is waiting (a boot's watch starts with its tool owner). */
    async waiting() { if (pending().length === 0) await new Promise<void>(resolve => { arrived = resolve; }); },
    /** Lets ONE interval elapse without waiting for what the watch does next (the caller observes the consequence elsewhere). */
    async expire() {
      const wait = await next();
      advance(wait.milliseconds);
      wait.resolve();
    },
    async tick() {
      const wait = await next();
      const moved = new Promise<void>(resolve => { progressed = resolve; });
      advance(wait.milliseconds);
      wait.resolve();
      await moved;
    } };
}
