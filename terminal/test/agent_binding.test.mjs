// src/lib/agent_binding.ts and src/lib/keys.ts: the Hyperliquid agent key
// is usable only with the wallet it was verified for (an external review
// found that changing the tracked wallet left the old agent usable, so the
// app could show one account and trade another).
import { test } from "node:test";
import assert from "node:assert/strict";

import { agentRefusal, keyMatchesBinding } from "../src/lib/agent_binding.ts";
import { deferred, fakeSettings, makeWorld, TEST_KEY } from "./helpers/world.mjs";

// Obviously fake addresses (never real ones).
const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);
const AGENT = "0x" + "c".repeat(40);

test("F2: an agent key is refused for any wallet but the one it was verified for", () => {
  const meta = { agentAddress: AGENT, wallet: WALLET_A };
  assert.equal(agentRefusal(meta, WALLET_A), null);
  assert.equal(agentRefusal(meta, WALLET_A.toUpperCase().replace("0X", "0x")), null);   // an address is not case-sensitive
  assert.match(agentRefusal(meta, WALLET_B), /added for another wallet \(0xaaaa\.\.\.aaaa\)/);
  assert.match(agentRefusal(meta, ""), /no wallet address/);
  assert.match(agentRefusal(meta, "0x1234"), /no wallet address/);
  assert.match(agentRefusal(null, WALLET_A), /no Hyperliquid agent key/);
});

test("F2: a key stored before the binding existed is refused until it is added again", () => {
  assert.match(agentRefusal({ agentAddress: AGENT, wallet: "" }, WALLET_A), /stored before keys were tied to a wallet/);
});

test("F2: the master-key refusal holds at use time, not only when the key is added", () => {
  assert.match(agentRefusal({ agentAddress: WALLET_A, wallet: WALLET_A }, WALLET_A), /this wallet's own key/);
  assert.equal(keyMatchesBinding(AGENT, { agentAddress: AGENT, wallet: WALLET_A }, WALLET_A), true);
  assert.equal(keyMatchesBinding(WALLET_B, { agentAddress: AGENT, wallet: WALLET_A }, WALLET_A), false);   // not the key the binding describes
  assert.equal(keyMatchesBinding(WALLET_A, { agentAddress: WALLET_A, wallet: WALLET_A }, WALLET_A), false);
});

// keys.ts for real, over a scripted key store.
function keysWorld(metaWallet, wallet) {
  const settings = fakeSettings({ wallet });
  const w = makeWorld({ mocks: { settings_store: settings } });
  const { deriveAddress } = w.load("hl_sign");
  const agentAddress = deriveAddress(TEST_KEY);
  const gate = deferred();
  const store = { meta: { wallet: metaWallet, agentAddress, name: "", validUntil: 0, storedAt: 0 }, key: TEST_KEY, reads: 0, gated: false };
  w.mocks.agent_store = {
    getAgentMeta: async () => store.meta,
    getAgentKey: async () => { store.reads++; if (store.gated) await gate.promise; return store.key; },
    getMfpKey: async () => null, getMfpMeta: async () => null, hasSessionMfpKey: () => false,
  };
  return { w, clock: w.clock, keys: w.load("keys"), settings, store, gate, agentAddress };
}

test("F2: the key is handed out for its own wallet and not for another, without even being read", async () => {
  const a = keysWorld(WALLET_A, WALLET_A);
  assert.equal(await a.clock.settle(a.keys.hlTradeKey()), TEST_KEY);
  assert.equal(await a.clock.settle(a.keys.hlKeyRefusal()), null);

  const b = keysWorld(WALLET_A, WALLET_B);                 // the tracked wallet was changed to B
  assert.equal(await b.clock.settle(b.keys.hlTradeKey()), null);
  assert.equal(b.store.reads, 0);                          // no fingerprint prompt for a key that may not be used
  assert.match(await b.clock.settle(b.keys.hlKeyRefusal()), /added for another wallet/);
});

test("F2: a wallet changed while the key prompt is up - the key is not handed out", async () => {
  const a = keysWorld(WALLET_A, WALLET_A);
  a.store.gated = true;
  const p = a.keys.hlTradeKey();
  await a.clock.flush();
  assert.equal(a.store.reads, 1);                          // the prompt is up
  a.settings.updateSettings({ wallet: WALLET_B });         // the wallet is changed under it
  a.gate.resolve();
  assert.equal(await a.clock.settle(p), null);
});

test("F2: a stored key that is not the one the binding describes is not handed out", async () => {
  const a = keysWorld(WALLET_A, WALLET_A);
  a.store.meta = { ...a.store.meta, agentAddress: AGENT };  // the meta names another agent
  assert.equal(await a.clock.settle(a.keys.hlTradeKey()), null);
  const b = keysWorld(WALLET_A, WALLET_A);
  b.store.meta = { ...b.store.meta, wallet: b.agentAddress };
  b.settings.updateSettings({ wallet: b.agentAddress });    // the "agent" key is the tracked wallet's own key
  assert.equal(await b.clock.settle(b.keys.hlTradeKey()), null);
});
