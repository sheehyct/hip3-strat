// The MyFundedPerps account stream, as pure logic (see
// SECURITY.md): what a frame means, where to resume, when to reconnect.
// Import-free: node --test loads it straight from source. The socket itself
// lives in src/lib/mfp_stream.ts.
//
// A frame is a CHANGE SIGNAL, never venue state: nothing here returns a
// position, an order, a fill or a balance. A relevant frame for the watched
// account tells the app to take its ordinary REST reading again. The field
// names read are the documented ones only (type, event, account_id, seq,
// time, stream_id, resumed, reason, replay, upstream_connected); anything
// else in a frame is ignored, and an unknown frame type is ignored.

export type MfpStreamSignal =
  | "state"     // positions, orders or the account changed: read them again
  | "history"   // a position closed: the closed-position history grew
  | "resync";   // events may have been missed: read everything again

// Where the stream stands: enough to resume it, nothing else. opening is
// true between a hello and its snapshot_end, while the venue sends the
// opening snapshots.
export type MfpStreamCursor = { streamId: string | null; lastSeq: number; lastTime: number; opening: boolean };

export const newMfpStreamCursor = (): MfpStreamCursor => ({ streamId: null, lastSeq: 0, lastTime: 0, opening: false });

export type MfpFrameResult = {
  cursor: MfpStreamCursor;
  signals: MfpStreamSignal[];
  // null = this frame says nothing about delay; false = the venue reports
  // its own upstream is down (events may be late); true = it is connected.
  upstream: boolean | null;
  reconnect: boolean;   // the venue asked for a reconnect (it is restarting)
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

const add = (list: MfpStreamSignal[], s: MfpStreamSignal) => { if (!list.includes(s)) list.push(s); };

// One parsed frame against the watched account. Never throws.
export function onMfpFrame(prev: MfpStreamCursor, frame: unknown, accountId: string): MfpFrameResult {
  const cursor: MfpStreamCursor = { ...prev };
  const out: MfpFrameResult = { cursor, signals: [], upstream: null, reconnect: false };
  if (!isObj(frame) || typeof frame.type !== "string") return out;
  const type = frame.type;

  if (type === "hello") {
    const id = typeof frame.stream_id === "string" && frame.stream_id ? frame.stream_id : null;
    if (frame.resumed === true && prev.streamId !== null) {
      // The venue still held the stream: the frames after last_seq follow.
      if (id !== null) cursor.streamId = id;
      return out;
    }
    // A new stream: its numbering starts again and fresh snapshots follow.
    // If a stream was held before, whatever happened in between was not
    // seen: read everything again. The very first stream of a connection
    // asks for nothing - the app has just taken its own reading, and the
    // opening snapshots repeat it.
    if (prev.streamId !== null) add(out.signals, "resync");
    cursor.streamId = id;
    cursor.lastSeq = 0;
    cursor.opening = true;
    return out;
  }
  if (type === "heartbeat") {
    out.upstream = frame.upstream_connected === false ? false : true;
    const t = num(frame.time);
    if (t !== null && t > cursor.lastTime) cursor.lastTime = t;
    return out;
  }
  if (type === "reconnect") { out.reconnect = true; return out; }

  // Numbered frames: every snapshot and event carries the next seq.
  const seq = num(frame.seq);
  if (seq !== null) {
    if (cursor.lastSeq > 0 && seq > cursor.lastSeq + 1) add(out.signals, "resync"); // a frame was lost
    if (seq > cursor.lastSeq) cursor.lastSeq = seq;
  }
  const t = num(frame.time);
  if (t !== null && t > cursor.lastTime) cursor.lastTime = t;

  if (type === "snapshot_end") {
    cursor.opening = false;
    // The replay after a reconnect could not cover the gap.
    const replay = isObj(frame.replay) ? frame.replay : null;
    if (replay && replay.complete === false) add(out.signals, "resync");
    return out;
  }
  // Everything below belongs to one account: another account's frame is not
  // this app's business (the key is scoped to one, but the frame decides).
  const forAccount = typeof frame.account_id === "string" ? frame.account_id : null;
  if (forAccount !== null && forAccount !== accountId) return out;

  if (type === "snapshot") {
    if (forAccount === null) return out;
    if (frame.reason === "resync") add(out.signals, "resync");
    // An opening snapshot is the state the hello already answered for; a
    // later one (an account newly reachable, say) is a change.
    else if (!prev.opening) add(out.signals, "state");
    return out;
  }
  if (forAccount === null) return out; // an event with no account (a price alert) is never a signal
  if (type === "order" || type === "fill" || type === "account") { add(out.signals, "state"); return out; }
  if (type === "position") {
    add(out.signals, "state");
    if (frame.event === "closed") add(out.signals, "history");
    return out;
  }
  return out;
}

// The venue holds a stream for about a minute after a disconnect. Asking to
// resume one it has dropped is pointless, and if it ever answers such a
// request with a refusal (rather than a fresh stream) every retry would
// repeat it: past the hold, connect fresh.
export const MFP_RESUME_HOLD_MS = 60_000;

// The resume query for a reconnect, or "" for a fresh connection. quietMs is
// how long ago this app last heard a frame (0 = unknown). The ids are the
// venue's own and are checked before they go into a URL; nothing secret is
// ever placed there.
export function mfpResumeQuery(c: MfpStreamCursor, quietMs = 0): string {
  if (quietMs > MFP_RESUME_HOLD_MS) return "";
  if (!c.streamId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(c.streamId) || c.lastSeq <= 0) return "";
  const since = c.lastTime > 0 ? "&since=" + Math.floor(c.lastTime) : "";
  return "?resume=" + c.streamId + "&last_seq=" + Math.floor(c.lastSeq) + since;
}

// A connection attempt that ended without a single frame: the next attempt
// asks for a FRESH stream (no resume query), in case the resume was what the
// venue refused. The stream id is kept, so the hello that follows still
// counts as "a new stream after one was held" and asks for a full read.
export const mfpForgetResume = (c: MfpStreamCursor): MfpStreamCursor => ({ ...c, lastSeq: 0, opening: false });

// No frame of any kind for this long = a dead connection (the venue sends a
// heartbeat every 15 s).
export const MFP_STREAM_SILENT_MS = 45_000;
export const mfpStreamDead = (lastFrameAt: number, now: number): boolean => now - lastFrameAt > MFP_STREAM_SILENT_MS;

// What to do when the socket closes. "stop": the venue refused the key
// (revoked, expired, sandbox lapsed) - asking again would only repeat it, so
// the stream stays off until the key changes or the app restarts.
export type MfpClosePolicy = "now" | "backoff" | "slow" | "stop";

export function mfpClosePolicy(code: number | null | undefined): MfpClosePolicy {
  if (code === 4001) return "stop";
  if (code === 1012) return "now";       // restarting: reconnect at once
  if (code === 4013) return "slow";      // at capacity
  return "backoff";
}

// A refused upgrade has no close code of its own: React Native reports it as
// code 1006 with the HTTP status in the close REASON ("Expected HTTP 101
// response but was '401 ...'"), which mfp_stream.ts hands here.
export function mfpUpgradePolicy(message: string | null | undefined): MfpClosePolicy {
  if (typeof message !== "string") return "backoff";
  if (/\b(401|403)\b/.test(message)) return "stop";
  if (/\b(429|503)\b/.test(message)) return "slow";
  return "backoff";
}

// The wait before reconnect number `attempt` (0 = the first), with jitter so
// several accounts never reconnect in step. rand is in [0, 1).
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const SLOW_RETRY_MS = 60_000;
export function mfpRetryDelayMs(attempt: number, policy: MfpClosePolicy, rand: number): number {
  const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, rand));
  if (policy === "now") return attempt === 0 ? 0 : Math.round(RETRY_MS[Math.min(attempt - 1, RETRY_MS.length - 1)] * jitter);
  const base = RETRY_MS[Math.min(Math.max(0, Math.floor(attempt)), RETRY_MS.length - 1)];
  return Math.round(Math.max(base, policy === "slow" ? SLOW_RETRY_MS : 0) * jitter);
}

// Stream-triggered re-reads are spaced at least this far apart, so a burst
// of events (an order, its fill and the position it moved) costs one read.
export const MFP_SIGNAL_MIN_GAP_MS = 1_500;
