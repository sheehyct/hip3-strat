// The write session and the write's claim on its market. PURE, no imports.
//
// The session: one number that changes whenever the venue clients are
// swapped (demo <-> live) or the tracked wallet changes. A write captures it
// when it starts and hands it down to the exchange clients, which check it
// on the last line before every sign / send. A write that began in one
// session can therefore never send in another: not after a wait on key
// access, and not on the later leg of a sequence (a reverse's opening
// order, an attached exit, Flat's cancel). venue_store.ts ends the session;
// nothing else does.
//
// The claim: venue_store.ts gives every write a claim on its market when
// it starts (withClaim). While a write only WAITS (a lost answer's payload
// to expire, the venue to finish) it stops counting as in flight, so Close,
// Flat and Cancel can start on that market meanwhile. A later leg of the
// waiting write (a reverse's opening order, an attached exit, Flat's cancel)
// must then not be sent beside them: the same last-line check asks the
// claim, and the claim refuses once any other write has started on the
// market since this one did. The leg is not sent; the write stops there.
export type Claim = () => string | null;   // null = this write may still send; a string = why not
export type Session = { readonly epoch: number; readonly claim: Claim | null };

let epoch = 0;
let base: Session = { epoch: 0, claim: null };
let active: Claim | null = null;

// Captured by an adapter BEFORE its first await: that is how the claim set
// by withClaim() reaches the exchange clients.
export const currentSession = (): Session => (active ? { epoch, claim: active } : base);
export function endSession(): void {
  epoch++;
  base = { epoch, claim: null };
}

// Run the synchronous start of a write (up to its first await) with its
// claim attached to every session captured in it.
export function withClaim<T>(claim: Claim, start: () => T): T {
  const prev = active;
  active = claim;
  try {
    return start();
  } finally {
    active = prev;
  }
}

export const STALE_SESSION_TEXT = "the app switched between demo and live while this was in flight; nothing more was sent";

// Why a send in this session must not happen now, or null.
export function sessionRefusal(s: Session): string | null {
  if (s.epoch !== epoch) return STALE_SESSION_TEXT;
  return s.claim ? s.claim() : null;
}
export const sessionLive = (s: Session): boolean => sessionRefusal(s) === null;

// Thrown instead of sending. It always means "this send did not happen".
export class StaleSession extends Error {
  constructor(message: string = STALE_SESSION_TEXT) {
    super(message);
    this.name = "StaleSession";
  }
}

export function assertSession(s: Session): void {
  const why = sessionRefusal(s);
  if (why !== null) throw new StaleSession(why);
}
