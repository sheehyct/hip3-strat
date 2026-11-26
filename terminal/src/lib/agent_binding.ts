// The Hyperliquid agent key belongs to ONE master wallet: the one whose
// approved-agents list it was verified against when it was added. An agent
// key signs for that wallet whatever address the app is tracking, so a
// tracked wallet that no longer matches would SHOW one account and TRADE
// another. PURE, no imports: the rule lives here so node --test loads it.
//
// agentRefusal() is asked before a key is used and again after it has been
// read (the read can sit behind a fingerprint prompt, and the wallet can
// change while it is up).
export type AgentBinding = { agentAddress: string; wallet: string };

const short = (a: string): string => (a.length > 10 ? a.slice(0, 6) + "..." + a.slice(-4) : a);
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const isAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

// Why the stored agent key may NOT be used with the tracked wallet, or null.
export function agentRefusal(meta: AgentBinding | null, wallet: string): string | null {
  if (!isAddress(wallet)) return "no wallet address in Settings";
  if (!meta) return "no Hyperliquid agent key";
  // The equality refusal, at use time as well as when the key was added.
  if (same(meta.agentAddress, wallet)) return "the stored key is this wallet's own key - remove it; only an API-wallet (agent) key may be stored";
  if (!meta.wallet) return "the agent key was stored before keys were tied to a wallet - remove it and add it again";
  if (!same(meta.wallet, wallet)) return "the agent key was added for another wallet (" + short(meta.wallet) + ") - remove it and add this wallet's agent key";
  return null;
}

// The key that came out of the store must be the one the binding describes:
// its derived address is the recorded agent address, and never the wallet.
export function keyMatchesBinding(derivedAddress: string, meta: AgentBinding, wallet: string): boolean {
  return same(derivedAddress, meta.agentAddress) && !same(derivedAddress, wallet);
}
