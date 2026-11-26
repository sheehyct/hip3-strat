// One reading at a time, however many things ask for it. Pure and
// import-free: node --test loads it straight from source.
//
// The MFP Portfolio block is asked to read the venue by a timer, a
// pull-to-refresh, a finished trade and the account stream, often within the
// same second. Every reading spends the key's GET budget (src/lib/mfp_rate.ts),
// so:
// - readings never overlap;
// - a request made while one is in flight runs ONE more reading after it -
//   one that STARTS after the request, so it cannot miss what the request
//   was about - and any number of requests in that time cost that one;
// - two readings never start closer together than minGapMs: a request that
//   comes too soon is run when the gap has passed, and further requests
//   before then are already served by it.
// No request is ever lost: after the last one, a reading always starts.

export type ReadGate = {
  request: () => void;
  busy: () => boolean;      // a reading is in flight right now
  open: () => void;         // (re)start accepting requests
  close: () => void;        // drop the pending reading and refuse requests
};

type Timer = ReturnType<typeof setTimeout>;

export function makeReadGate(
  run: () => Promise<unknown>,
  minGapMs: number,
  now: () => number = Date.now,
  later: (fn: () => void, ms: number) => Timer = setTimeout,
  cancel: (t: Timer) => void = clearTimeout,
): ReadGate {
  let inFlight = false;
  let again = false;
  let lastStart = -Infinity;
  let pending: Timer | null = null;
  let closed = false;

  const schedule = () => {
    const wait = Math.max(0, lastStart + minGapMs - now());
    pending = later(() => { pending = null; if (!closed) start(); }, wait);
  };

  const start = () => {
    inFlight = true;
    again = false;
    lastStart = now();
    const done = () => {
      inFlight = false;
      if (closed || !again) return;
      again = false;
      schedule();
    };
    let p: Promise<unknown>;
    try { p = run(); } catch { done(); return; }
    p.then(done, done);
  };

  return {
    request: () => {
      if (closed) return;
      if (inFlight) { again = true; return; }
      if (pending) return; // the reading already scheduled starts after this request
      if (now() - lastStart < minGapMs) { schedule(); return; }
      start();
    },
    busy: () => inFlight,
    open: () => { closed = false; },
    close: () => {
      closed = true;
      again = false;
      if (pending) { cancel(pending); pending = null; }
    },
  };
}
