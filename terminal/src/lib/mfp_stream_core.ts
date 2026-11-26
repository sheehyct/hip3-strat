// MyFundedPerps' account stream, read as a CHANGE SIGNAL and nothing more.
// PURE and import-free (node --test loads it from source): the frame
// reading and the connect / resume / back-off rules. The socket itself, and
// the key, live in mfp_stream.ts.
//
// The rule this file keeps (docs/CONTRACT.md "The MFP account stream"): a pushed
// frame is never venue state. It can only say "read the venue now". So a
// frame is reduced to its ENVELOPE (type, event, account_id, seq, time and a
// few flags); its payload - orders, positions, balances - is never read,
// never shown and never settles a write. What a frame for this account
// turns into is one of three signals:
//   "state"    read the book (positions + working orders) again
//   "history"  read the history again (a fill, an order that ended)
//   "resync"   something may have been missed (a new stream that could not
//              be resumed, a gap in seq, the venue's own "resync"
//              snapshot): read the book again, in full, now
// The store answers a signal with the same REST read the timer makes.
//
// Field names are from MFP's doc for the stream; the envelope names were
// later checked read-only against the sandbox stream. Where a field is missing the
// reading is the cautious one: an event with no account_id is taken as
// possibly ours (one wasted read), and a stream that never names this
// account in a snapshot is never called live (the timer keeps its full
// pace).

export type StreamSignal = "state" | "history" | "resync";

// No frame of any kind for this long: the connection is dead (the venue
// sends a heartbeat every 15 s).
export const WATCHDOG_MS = 45_000;
// Waits between connection attempts, in turn; the last one repeats.
export const LADDER_MS: readonly number[] = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000, 60_000]);
// A connection that stayed live this long starts the ladder again.
export const STEADY_MS = 30_000;
// Close codes the venue documents.
export const CLOSE_RESTARTING = 1012;   // reconnect now
export const CLOSE_REJECTED = 4001;     // key revoked / session expired / sandbox lapsed: do not retry the key
export const CLOSE_CAPACITY = 4013;     // at capacity: back off, with jitter
// The line the web relay writes when the venue closes the socket.
export const RELAY_CLOSED = "tt_stream_closed";
// How long the venue holds a stream for a resume (its doc: about 60 s). A
// stream not heard from for longer is not asked for again.
export const RESUME_HOLD_MS = 60_000;
// The longest frame (or relayed line) the app reads, in characters. The
// relay forwards at most half of this (server/mfp_stream_relay.mjs,
// MAX_FRAME_BYTES; a test holds the two together), so a frame the relay
// lets through is never one the app gives up on.
export const MAX_FRAME_CHARS = 8 * 1024 * 1024;

const ID_TEXT = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL_ORDER_EVENTS = ["filled", "canceled", "cancelled", "rejected", "expired"];

// ---- one frame's envelope ---------------------------------------------------

export type Frame = {
  type: string;
  event: string | null;
  accountId: string | null;
  seq: number | null;
  time: number | null;
  reason: string | null;        // a snapshot's: "resync" | "added"
  streamId: string | null;      // hello
  resumed: boolean | null;      // hello
  upstream: boolean | null;     // heartbeat: upstream_connected
  replayComplete: boolean | null;   // snapshot_end: replay.complete
  code: number | null;          // the relay's closing line: the close code
};

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

// One text frame -> its envelope, or null when it is not a JSON object with
// a type (it still counts as traffic for the watchdog).
export function parseFrame(text: unknown): Frame | null {
  if (typeof text !== "string" || text.length > MAX_FRAME_CHARS) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const type = str(o.type);
  if (!type) return null;
  const id = str(o.stream_id);
  const replay = o.replay !== null && typeof o.replay === "object" && !Array.isArray(o.replay) ? (o.replay as Record<string, unknown>).complete : undefined;
  return {
    type,
    event: str(o.event),
    accountId: str(o.account_id),
    seq: count(o.seq),
    time: count(o.time),
    reason: str(o.reason),
    streamId: id !== null && ID_TEXT.test(id) ? id : null,
    resumed: typeof o.resumed === "boolean" ? o.resumed : null,
    upstream: typeof o.upstream_connected === "boolean" ? o.upstream_connected : null,
    replayComplete: typeof replay === "boolean" ? replay : null,
    code: count(o.code),
  };
}

// ---- the stream's state -----------------------------------------------------

export type StreamCore = {
  accountId: string;           // the ONE account the app reads; other accounts' frames are ignored
  streamId: string | null;     // from hello: what a resume names
  lastSeq: number | null;      // the last seq seen on this stream (null = none yet)
  lastTime: number | null;     // the "time" of the last frame that carried one
  covered: boolean;            // a snapshot for accountId arrived on this stream
  synced: boolean;             // this connection is past its snapshots (or was resumed)
  upstream: boolean;           // false while a heartbeat says the venue's own feed is down
  attempts: number;            // connections that ended before staying live (the ladder's rung)
  liveSince: number | null;
  lastFrameAt: number;         // the watchdog's clock: the last frame, or the start of this attempt
  heardAt: number;             // when a frame last really arrived (0 = never)
  heard: boolean;              // this attempt has received at least one frame
  heldBefore: boolean;         // a stream was held at some point, whatever became of it
  stopped: boolean;            // the venue rejected the key (4001): no more attempts
};

export const newCore = (accountId: string): StreamCore => ({
  accountId, streamId: null, lastSeq: null, lastTime: null, covered: false, synced: false, upstream: true,
  attempts: 0, liveSince: null, lastFrameAt: 0, heardAt: 0, heard: false, heldBefore: false, stopped: false,
});

// Can the stream be relied on to say when this account changes? Only then
// does the store slow its timer.
export const isLive = (c: StreamCore): boolean => !c.stopped && c.synced && c.covered && c.upstream;

// The stream a resume would name is forgotten. It WAS held: the next hello
// is then a new stream after one was held, which asks for a full re-read.
const forget = (c: StreamCore): StreamCore => ({ ...c, streamId: null, lastSeq: null, lastTime: null, heldBefore: c.heldBefore || c.streamId !== null });

// A connection attempt begins; the watchdog runs from here. A stream the
// venue has stopped holding (nothing heard for RESUME_HOLD_MS) is not asked
// for again: this attempt is a fresh one.
export function onAttempt(c: StreamCore, now: number): StreamCore {
  const stale = c.streamId !== null && now - c.heardAt > RESUME_HOLD_MS;
  return { ...(stale ? forget(c) : c), heard: false, lastFrameAt: now };
}

// A connection opened (the upgrade was accepted / the relay answered 200).
export function onOpen(c: StreamCore, now: number): StreamCore {
  return { ...c, synced: false, upstream: true, liveSince: null, lastFrameAt: now };
}

// Anything at all arrived: the watchdog starts over.
export const touch = (c: StreamCore, now: number): StreamCore => ({ ...c, lastFrameAt: now, heardAt: now, heard: true });
export const watchdogDue = (c: StreamCore, now: number): boolean => now - c.lastFrameAt > WATCHDOG_MS;

export type Step = {
  core: StreamCore;
  signals: StreamSignal[];
  reconnect: boolean;          // the venue asked for a reconnect
};

const withLive = (before: StreamCore, after: StreamCore, now: number): StreamCore =>
  (isLive(after) && !isLive(before) ? { ...after, liveSince: now } : !isLive(after) ? { ...after, liveSince: null } : after);

// One frame. Returns the new state and what, if anything, to read.
export function onFrame(c0: StreamCore, f: Frame, now: number): Step {
  let c: StreamCore = { ...c0, lastFrameAt: now, heardAt: now, heard: true };
  const signals: StreamSignal[] = [];
  const add = (s: StreamSignal) => { if (!signals.includes(s)) signals.push(s); };
  const done = (reconnect = false): Step => ({ core: withLive(c0, c, now), signals, reconnect });

  if (f.type === "hello") {
    const resumed = f.resumed === true && f.streamId !== null && f.streamId === c.streamId && c.lastSeq !== null;
    if (resumed) {
      // The same stream goes on: what was missed is replayed as events.
      c = { ...c, synced: true };
    } else {
      // A new stream. When one was held before, everything between it and
      // this one is unknown: read again, in full. The FIRST stream raises
      // nothing here - the app has just read the venue itself, and the store
      // reads once more when the stream goes live (venue_store.ts).
      if (c.streamId !== null || c.heldBefore) add("resync");
      c = { ...c, streamId: f.streamId, lastSeq: null, lastTime: null, covered: false, synced: false, heldBefore: c.heldBefore || f.streamId !== null };
    }
    return done();
  }

  // A frame that names another account is not this app's business. One
  // that names none is taken as possibly ours.
  const ours = f.accountId === null || f.accountId === c.accountId;

  // seq. The doc says it counts every snapshot and event frame of the
  // stream, from 1. That is unverified, so seq is only ever a reason to
  // read MORE. It NEVER makes a frame go unread: every frame is still
  // classified below, whatever its seq.
  // - the first seq of a stream is taken as it comes (0, 1, anything);
  // - a jump forward is a gap: something was missed;
  // - a seq that does not go up, on a frame that is ours, means the count is
  //   not what the doc says (one count per account, a count that started
  //   again) or the frame is a repeat. The cautious answer to all three is
  //   a full re-read, and the count is followed from there. A true repeat
  //   costs one read it did not need;
  // - a seq that does not go up on ANOTHER account's frame is left alone.
  if (f.seq !== null) {
    const last = c.lastSeq;
    if (last === null) c = { ...c, lastSeq: f.seq, lastTime: f.time ?? c.lastTime };
    else if (f.seq > last) {
      if (f.seq > last + 1) add("resync");
      c = { ...c, lastSeq: f.seq, lastTime: f.time ?? c.lastTime };
    } else if (ours) {
      add("resync");
      c = { ...c, lastSeq: f.seq, lastTime: f.time ?? c.lastTime };
    }
  }

  switch (f.type) {
    case "snapshot":
      if (f.accountId === c.accountId) c = { ...c, covered: true };
      // The snapshots a connection opens with repeat what the app has just
      // read: they raise nothing (the store reads once when the stream goes
      // live). One the venue marks "resync", or one that arrives later (an
      // account added), does.
      if (ours && f.reason === "resync") add("resync");
      else if (ours && c.synced) add("state");
      return done();
    case "snapshot_end":
      c = { ...c, synced: true };
      // The venue could not replay everything since the resume point.
      if (f.replayComplete === false) add("resync");
      return done();
    case "order":
      if (ours) { add("state"); if (f.event !== null && TERMINAL_ORDER_EVENTS.includes(f.event)) add("history"); }
      return done();
    case "fill":
      if (ours) { add("state"); add("history"); }
      return done();
    case "position":
    case "account":
      if (ours) add("state");
      return done();
    case "heartbeat":
      if (f.upstream === false) c = { ...c, upstream: false };
      else if (!c.upstream) { c = { ...c, upstream: true }; add("resync"); }   // the venue's feed is back: what happened meanwhile is unknown
      return done();
    case "reconnect":
      return done(true);
    default:
      // price_alert, pong, notice, error, and anything not known: traffic only.
      return done();
  }
}

// The relay's closing line carries the venue's close code.
export const closeCodeOf = (f: Frame): number | null => (f.type === RELAY_CLOSED ? f.code ?? 1006 : null);

// A REFUSED upgrade has no close code of its own. React Native reports it as
// close 1006 whose reason carries the HTTP status ("Expected HTTP 101
// response but was '401 Unauthorized'"); the web relay's own refusals come
// as "HTTP 4xx". The status, or null when the text names none.
export function refusedStatus(reason: string | null | undefined): number | null {
  if (typeof reason !== "string") return null;
  // The status the platform GOT ("... but was '401 Unauthorized'"), not the
  // 101 it expected; or the relay's whole reason, "HTTP 403".
  const m = reason.match(/\bbut was '?([1-5][0-9]{2})\b/) ?? reason.match(/^HTTP ([1-5][0-9]{2})$/);
  return m ? Number(m[1]) : null;
}

// The connection ended. code: the close code (null = none was given - a
// network failure, the watchdog). reason: the close's text, when the
// platform gives one. delayMs: how long to wait before the next attempt;
// null = never (the key was rejected). rand: () => [0, 1), for the jitter.
//
// The ladder's rung goes back to the first only after a connection that
// stayed live for STEADY_MS. A socket the venue accepts and then drops, over
// and over, climbs the ladder like one it refuses: it is never met with a
// connection a second.
export function onClosed(c0: StreamCore, code: number | null, now: number, rand: () => number, reason: string | null = null): { core: StreamCore; delayMs: number | null } {
  const steady = c0.liveSince !== null && now - c0.liveSince >= STEADY_MS;
  const attempts = steady ? 0 : c0.attempts;
  // An attempt that never received a frame may have been refused FOR its
  // resume (an expired one answered with an HTTP error, not with hello
  // resumed:false): the next attempt does not ask for that stream again.
  const kept = c0.heard ? c0 : forget(c0);
  const base: StreamCore = { ...kept, synced: false, upstream: true, liveSince: null, attempts: attempts + 1 };
  const refused = code === null || code === 1006 ? refusedStatus(reason) : null;
  // The venue will not take this key (revoked, expired, a lapsed sandbox;
  // or an upgrade refused 401 / 403): trying it again cannot help.
  if (code === CLOSE_REJECTED || refused === 401 || refused === 403) return { core: { ...base, stopped: true }, delayMs: null };
  const rung = LADDER_MS[Math.min(attempts, LADDER_MS.length - 1)];
  const r = Math.min(0.999999, Math.max(0, rand()));
  // The venue is restarting and this connection had been steady: go back
  // at once.
  if (code === CLOSE_RESTARTING && attempts === 0) return { core: base, delayMs: 250 };
  // At capacity, or too many sockets on the key (an upgrade refused 429):
  // back off further, with wide jitter.
  if (code === CLOSE_CAPACITY || refused === 429) return { core: base, delayMs: Math.round(Math.max(rung, 10_000) * (0.5 + r)) };
  return { core: base, delayMs: Math.round(rung * (0.8 + 0.4 * r)) };
}

// The query a reconnect carries to pick the stream up where it stopped, or
// "" for a fresh connection. Only when the stream id, the last seq and the
// last time are all known; each is written out from a checked value, so the
// query can add nothing to the address but these three.
export function resumeQuery(c: StreamCore): string {
  if (c.stopped || c.streamId === null || !ID_TEXT.test(c.streamId) || c.lastSeq === null || c.lastTime === null) return "";
  if (!Number.isSafeInteger(c.lastSeq) || c.lastSeq < 0 || !Number.isSafeInteger(c.lastTime) || c.lastTime < 0) return "";
  return "?resume=" + c.streamId + "&last_seq=" + String(c.lastSeq) + "&since=" + String(c.lastTime);
}

export type StreamStatus = "off" | "connecting" | "live" | "down" | "rejected";
// connected: a socket is open right now.
export function statusOf(c: StreamCore | null, connected: boolean): StreamStatus {
  if (!c) return "off";
  if (c.stopped) return "rejected";
  if (!connected) return "down";
  return isLive(c) ? "live" : "connecting";
}
