// Hyperliquid L1 action signing, a byte-for-byte port of the Python SDK's
// signing.py (action_hash / construct_phantom_agent / l1_payload /
// sign_l1_action), pinned by the SDK's own test vectors in
// test/hl_sign.test.mjs. PURE: noble + msgpack only, nothing from
// react-native, expo or storage, so node --test loads it from source and
// scripts/check-exchange-guard.js can keep it that way.
//
// Only src/lib/hl_exchange.ts may call signL1Action (the static guard
// enforces it); the key it passes is a Hyperliquid API-wallet (agent) key
// read from the device secure store for one call and dropped.
import { encode } from "@msgpack/msgpack";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";

export type L1Signature = { r: string; s: string; v: 27 | 28 };

// Every string this module hashes is ASCII by construction; a tiny encoder
// keeps TextEncoder out of the dependency surface.
function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127) throw new Error("non-ASCII input");
    out[i] = c;
  }
  return out;
}

function u64be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("u64: not a safe non-negative integer");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function u256be(n: bigint): Uint8Array {
  return hexToBytes(n.toString(16).padStart(64, "0"));
}

function stripHex(h: string): string {
  return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}

export function addressBytes(address: string): Uint8Array {
  const h = stripHex(address);
  if (!/^[0-9a-fA-F]{40}$/.test(h)) throw new Error("bad address");
  return hexToBytes(h.toLowerCase());
}

function keyBytes(privKeyHex: string): Uint8Array {
  const h = stripHex(privKeyHex);
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("bad private key");
  return hexToBytes(h.toLowerCase());
}

function addressOfPublicKey(uncompressed: Uint8Array): string {
  if (uncompressed.length !== 65 || uncompressed[0] !== 4) throw new Error("expected an uncompressed public key");
  const h = keccak_256(uncompressed.slice(1));
  return "0x" + bytesToHex(h.slice(12));
}

// The EVM address of an API-wallet key (lowercase 0x hex).
export function deriveAddress(privKeyHex: string): string {
  return addressOfPublicKey(secp256k1.getPublicKey(keyBytes(privKeyHex), false));
}

// action_hash(): msgpack(action) ++ nonce u64 BE ++ (0x00 | 0x01 ++ vault)
// ++ (0x00 ++ expiresAfter u64 BE)?, keccak256.
export function actionHash(action: object, nonce: number, vault: string | null, expiresAfter: number | null): Uint8Array {
  const parts: Uint8Array[] = [encode(action), u64be(nonce)];
  if (vault === null) parts.push(new Uint8Array([0]));
  else parts.push(new Uint8Array([1]), addressBytes(vault));
  if (expiresAfter !== null) parts.push(new Uint8Array([0]), u64be(expiresAfter));
  return keccak_256(concatBytes(...parts));
}

// EIP-712 digest of the phantom Agent {source, connectionId} under the
// fixed Exchange domain (chainId 1337, zero verifying contract).
const AGENT_TYPE = keccak_256(asciiBytes("Agent(string source,bytes32 connectionId)"));
const DOMAIN_TYPE = keccak_256(asciiBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const DOMAIN_SEPARATOR = keccak_256(concatBytes(
  DOMAIN_TYPE,
  keccak_256(asciiBytes("Exchange")),
  keccak_256(asciiBytes("1")),
  u256be(1337n),
  u256be(0n),
));

export function agentDigest(hash: Uint8Array, isMainnet: boolean): Uint8Array {
  if (hash.length !== 32) throw new Error("connectionId must be 32 bytes");
  const structHash = keccak_256(concatBytes(AGENT_TYPE, keccak_256(asciiBytes(isMainnet ? "a" : "b")), hash));
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

const SIGN_OPTS = { prehash: false, lowS: true, extraEntropy: false, format: "recovered" as const };

// sign_l1_action(): deterministic RFC6979 over the EIP-712 digest; v is
// 27 + the recovery bit, r and s zero-padded 32-byte hex.
export function signL1Action(
  privKeyHex: string, action: object, nonce: number, vault: string | null,
  expiresAfter: number | null, isMainnet: boolean,
): L1Signature {
  const digest = agentDigest(actionHash(action, nonce, vault, expiresAfter), isMainnet);
  const bytes = secp256k1.sign(digest, keyBytes(privKeyHex), SIGN_OPTS);
  const sig = secp256k1.Signature.fromBytes(bytes, "recovered");
  if (sig.recovery !== 0 && sig.recovery !== 1) throw new Error("no recovery bit");
  return {
    r: "0x" + sig.r.toString(16).padStart(64, "0"),
    s: "0x" + sig.s.toString(16).padStart(64, "0"),
    v: sig.recovery === 1 ? 28 : 27,
  };
}

// The address a signature recovers to - the self-test (Settings) and the
// tests compare it with deriveAddress(key). Never used to gate a send.
export function recoverL1Signer(
  action: object, sig: L1Signature, nonce: number, vault: string | null,
  expiresAfter: number | null, isMainnet: boolean,
): string {
  const digest = agentDigest(actionHash(action, nonce, vault, expiresAfter), isMainnet);
  const S = new secp256k1.Signature(BigInt(sig.r), BigInt(sig.s), sig.v - 27);
  const pub = S.recoverPublicKey(digest).toBytes(false);
  return addressOfPublicKey(pub);
}

// The SDK's dummy vector (public test key, nonce 0, mainnet) as a device
// self-test: proves Hermes + noble + msgpack reproduce the Python bytes on
// the installed build. No secret is involved.
export const SELF_TEST = {
  key: "0x0123456789012345678901234567890123456789012345678901234567890123",
  action: { type: "dummy", num: 100000000000 },
  r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
  s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
  v: 27,
} as const;

export function selfTest(): boolean {
  try {
    const sig = signL1Action(SELF_TEST.key, SELF_TEST.action, 0, null, null, true);
    return BigInt(sig.r) === BigInt(SELF_TEST.r) && BigInt(sig.s) === BigInt(SELF_TEST.s) && sig.v === SELF_TEST.v;
  } catch {
    return false;
  }
}
