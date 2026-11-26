// Byte-for-byte pins of src/lib/hl_sign.ts against the hyperliquid-python-sdk.
// The first four vectors are the SDK's own tests (tests/signing_test.py);
// the rest were generated 2026-09-02 from the same SDK with the same PUBLIC
// test key (nonce, expires_after, cloid, cancel, testnet, a builder-dex close).
// r and s compare as BigInt because the SDK's to_hex strips leading zeros.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  actionHash, agentDigest, deriveAddress, recoverL1Signer, selfTest, signL1Action,
} from "../src/lib/hl_sign.ts";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325";
const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const same = (sig, exp) => {
  assert.equal(BigInt(sig.r), BigInt(exp.r), "r");
  assert.equal(BigInt(sig.s), BigInt(exp.s), "s");
  assert.equal(sig.v, exp.v, "v");
};

const DUMMY = { type: "dummy", num: 100000000000 };
const ORDER = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };

test("address derivation of the SDK test key", () => {
  assert.equal(deriveAddress(KEY), ADDRESS);
  assert.equal(deriveAddress(KEY.slice(2)), ADDRESS);
  assert.throws(() => deriveAddress("0x1234"));
});

test("SDK vector: dummy action, mainnet", () => {
  assert.equal(hex(actionHash(DUMMY, 0, null, null)), "0xf528daee6a0bd11407b483cfcd9a48c56884180b70ee86f124053e5fc1bf4d57");
  same(signL1Action(KEY, DUMMY, 0, null, null, true), {
    r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
    s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", v: 27,
  });
});

test("SDK vector: dummy action, testnet source b", () => {
  same(signL1Action(KEY, DUMMY, 0, null, null, false), {
    r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
    s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", v: 28,
  });
});

test("SDK vector: dummy action with expires_after 1", () => {
  assert.equal(hex(actionHash(DUMMY, 0, null, 1)), "0x2019d09f790a495b1bb18cd66d810253f6903ff92497d8f3bba335dbf620a3e6");
  same(signL1Action(KEY, DUMMY, 0, null, 1, true), {
    r: "0xe05539c3593e35af057021776f515ff3d742fda6d2ead95afc191259666b678d",
    s: "0x55956e89aec326d9fd02bdf5bc73cb6416082fcdabdfce4680c34a4ea75d2d98", v: 28,
  });
});

test("SDK vector: dummy action with a vault address", () => {
  assert.equal(hex(actionHash(DUMMY, 0, "0x1719884eb866cb12b2287399b15f7db5e7d775ea", null)), "0xde9e09a7a3da45cc694096d4bfdcd89bc1b892d05497c5ecc1f56c335945184c");
  same(signL1Action(KEY, DUMMY, 0, "0x1719884eb866cb12b2287399b15f7db5e7d775ea", null, true), {
    r: "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239",
    s: "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c", v: 28,
  });
});

test("SDK vector: ETH Gtc order, mainnet and testnet", () => {
  assert.equal(hex(actionHash(ORDER, 0, null, null)), "0x884f2c32bb6dbdd65f6033e32fb28c0cb6f5b345db0f6471fd3366d85c9252c1");
  same(signL1Action(KEY, ORDER, 0, null, null, true), {
    r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
    s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28,
  });
  same(signL1Action(KEY, ORDER, 0, null, null, false), {
    r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
    s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27,
  });
});

test("SDK vector: order with a cloid (key order a,b,p,s,r,t,c)", () => {
  const action = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } }, c: "0x00000000000000000000000000000001" }], grouping: "na" };
  assert.equal(hex(actionHash(action, 0, null, null)), "0x0ba500cedd8f4ba6ded620a0b1cd04f124d9ba745e2e2893fcc763bcc1444af5");
  same(signL1Action(KEY, action, 0, null, null, true), {
    r: "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
    s: "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da", v: 27,
  });
});

test("SDK vector: the app's own shape - a builder-dex reduce-only IoC close with a real nonce and expiresAfter", () => {
  const close = { type: "order", orders: [{ a: 110005, b: false, p: "229.09", s: "0.42", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" };
  assert.equal(hex(actionHash(close, 1788400000000, null, 1788400060000)), "0x502900dd7b6c115a4822e83600091e20147dcdbc2f290fa5d86f07081c86cceb");
  same(signL1Action(KEY, close, 1788400000000, null, 1788400060000, true), {
    r: "0xcd7b78980b50f23b570d9f197a6746273703bd559056c1348e5621165d85e018",
    s: "0x1c3f343562a8e02e69837df92d5dc57a543848731c4627987d61296c3ae4f368", v: 28,
  });
});

test("SDK vector: cancel action", () => {
  const cancel = { type: "cancel", cancels: [{ a: 110005, o: 534160744038 }] };
  assert.equal(hex(actionHash(cancel, 1788400000000, null, null)), "0x5525c05652c3dd64d616c253ffeaf690c93022ee9875cdcccef44dfdba9b6bff");
  same(signL1Action(KEY, cancel, 1788400000000, null, null, true), {
    r: "0x52efc4e5deeb988aa5246517b0c085201047426b43c82029ff6db51f64644b3e",
    s: "0x5c9d9400388e6b76171b0f797ff25849d14f395c89d46128ae63461db80acef7", v: 28,
  });
});

test("recover(sign(x)) is the key's address for varied inputs; a wrong key is not", () => {
  const cases = [
    [DUMMY, 0, null, null, true], [ORDER, 12345, null, null, false],
    [{ type: "cancel", cancels: [{ a: 3, o: 9 }] }, 1788400000000, null, 1788400060000, true],
    [DUMMY, 7, "0x1719884eb866cb12b2287399b15f7db5e7d775ea", null, true],
  ];
  for (const [action, nonce, vault, exp, mainnet] of cases) {
    const sig = signL1Action(KEY, action, nonce, vault, exp, mainnet);
    assert.equal(recoverL1Signer(action, sig, nonce, vault, exp, mainnet), ADDRESS);
    assert.notEqual(recoverL1Signer(action, sig, nonce + 1, vault, exp, mainnet), ADDRESS, "a different nonce recovers elsewhere");
  }
  const other = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const sig = signL1Action(other, DUMMY, 0, null, null, true);
  assert.notEqual(recoverL1Signer(DUMMY, sig, 0, null, null, true), ADDRESS);
});

test("agentDigest differs between mainnet and testnet and rejects a short hash", () => {
  const h = actionHash(DUMMY, 0, null, null);
  assert.notEqual(hex(agentDigest(h, true)), hex(agentDigest(h, false)));
  assert.throws(() => agentDigest(new Uint8Array(31), true));
});

test("input validation: bad key, bad vault, bad nonce", () => {
  assert.throws(() => signL1Action("0xzz", DUMMY, 0, null, null, true));
  assert.throws(() => actionHash(DUMMY, 0, "0x1234", null));
  assert.throws(() => actionHash(DUMMY, -1, null, null));
  assert.throws(() => actionHash(DUMMY, 1.5, null, null));
});

test("the device self-test vector passes here", () => {
  assert.equal(selfTest(), true);
});
