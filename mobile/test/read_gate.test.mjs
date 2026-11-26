// src/lib/read_gate.ts: one reading at a time, a minimum gap between
// readings, and no request ever lost. Time and timers are faked.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeReadGate } from "../src/lib/read_gate.ts";

// A fake clock with timers, and a reading that finishes only when told to.
function rig(minGap = 1500) {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  const starts = [];
  const open = [];
  const run = () => { starts.push(t); return new Promise((resolve, reject) => open.push({ resolve, reject })); };
  const gate = makeReadGate(run, minGap, () => t, (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; }, (id) => timers.delete(id));
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return {
    gate, starts, timers,
    // finish the reading in flight
    finish: async (fail = false) => { const p = open.shift(); if (fail) p.reject(new Error("x")); else p.resolve(); await settle(); },
    // move the clock, firing due timers in order
    advance: async (ms) => {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await settle();
      }
      t = end;
    },
  };
}

test("a first request reads at once", () => {
  const r = rig();
  r.gate.request();
  assert.deepEqual(r.starts, [0]);
  assert.equal(r.gate.busy(), true);
});

test("readings never overlap: requests during one cost ONE more, started after the gap", async () => {
  const r = rig();
  r.gate.request();
  await r.advance(200);
  r.gate.request();
  r.gate.request();
  r.gate.request();
  assert.deepEqual(r.starts, [0]);
  await r.advance(300);
  await r.finish();              // the first ends at 500 ms
  assert.equal(r.gate.busy(), false);
  assert.deepEqual(r.starts, [0]);   // not yet: the gap
  await r.advance(999);
  assert.deepEqual(r.starts, [0]);
  await r.advance(1);
  assert.deepEqual(r.starts, [0, 1500]);
  await r.finish();
  await r.advance(10_000);
  assert.deepEqual(r.starts, [0, 1500]); // and no third
});

test("the follow-up starts AFTER the request it serves", async () => {
  const r = rig(100);
  r.gate.request();
  await r.advance(5000);         // a slow reading
  r.gate.request();              // a trade finished at 5000
  await r.finish();
  await r.advance(0);
  assert.deepEqual(r.starts, [0, 5000]);
  assert.ok(r.starts[1] >= 5000);
});

test("a request during the wait for a scheduled reading is already served by it", async () => {
  const r = rig();
  r.gate.request();
  r.gate.request();              // asks for one more
  await r.advance(500);
  await r.finish();              // follow-up scheduled for 1500
  await r.advance(300);
  r.gate.request();              // at 800: the reading at 1500 starts after it
  r.gate.request();
  await r.advance(700);
  assert.deepEqual(r.starts, [0, 1500]);
  await r.finish();
  await r.advance(10_000);
  assert.deepEqual(r.starts, [0, 1500]);
});

test("an idle request that comes too soon waits for the gap instead of reading at once", async () => {
  const r = rig();
  r.gate.request();
  await r.advance(100);
  await r.finish();
  await r.advance(500);
  r.gate.request();              // idle at 600, only 600 ms after the last start
  assert.deepEqual(r.starts, [0]);
  await r.advance(900);
  assert.deepEqual(r.starts, [0, 1500]);
});

test("a stream of signals every 400 ms costs one reading per gap, and none is lost", async () => {
  const r = rig();
  for (let i = 0; i < 25; i++) {       // 10 s of signals
    r.gate.request();
    if (r.gate.busy()) { await r.advance(200); await r.finish(); await r.advance(200); } else await r.advance(400);
  }
  await r.advance(5000);
  if (r.gate.busy()) await r.finish();
  await r.advance(5000);
  for (let i = 1; i < r.starts.length; i++) assert.ok(r.starts[i] - r.starts[i - 1] >= 1500, "gap " + (r.starts[i] - r.starts[i - 1]));
  assert.ok(r.starts.length <= 8, "saw " + r.starts.length);
  assert.ok(r.starts[r.starts.length - 1] >= 9600 - 1500, "the last signal was served");
});

test("a reading that fails or throws still releases the gate", async () => {
  const r = rig(0);
  r.gate.request();
  r.gate.request();
  await r.finish(true);
  await r.advance(0);
  assert.equal(r.starts.length, 2);
  await r.finish();
  let calls = 0;
  const g = makeReadGate(() => { calls++; throw new Error("sync"); }, 0, () => 0);
  g.request();
  assert.equal(g.busy(), false);
  g.request();
  assert.equal(calls, 2);
});

test("close drops the pending reading and refuses requests; open accepts them again", async () => {
  const r = rig();
  r.gate.request();
  r.gate.request();
  await r.finish();
  assert.equal(r.timers.size, 1);
  r.gate.close();
  assert.equal(r.timers.size, 0);
  r.gate.request();
  await r.advance(10_000);
  assert.deepEqual(r.starts, [0]);
  r.gate.open();
  r.gate.request();
  assert.equal(r.starts.length, 2);
});

test("closing while a reading is in flight starts nothing after it", async () => {
  const r = rig();
  r.gate.request();
  r.gate.request();
  r.gate.close();
  await r.finish();
  await r.advance(10_000);
  assert.deepEqual(r.starts, [0]);
  assert.equal(r.timers.size, 0);
});
