// Which key a venue call uses. Trade keys are read for ONE call and handed
// to the client; they never enter store state. On Android the read fires
// the biometric prompt (agent_store.ts); on web it is the tab's session.
import { agentRefusal, keyMatchesBinding } from "./agent_binding";
import { getAgentKey, getAgentMeta, getMfpKey, getMfpMeta, hasSessionMfpKey } from "./agent_store";
import { deriveAddress } from "./hl_sign";
import { getSettings } from "./settings_store";
import { Platform } from "react-native";

// Why the Hyperliquid agent key cannot be used right now, or null. The key
// is tied to the wallet it was verified for (agent_binding.ts).
export async function hlKeyRefusal(): Promise<string | null> {
  return agentRefusal(await getAgentMeta(), getSettings().wallet);
}

// The agent key for ONE write, or null. The binding to the tracked wallet is
// checked before the read and again after it: the read can wait on a
// fingerprint prompt, and the wallet can be changed while it is up. The key
// that comes out must also be the key the binding describes.
export async function hlTradeKey(): Promise<string | null> {
  try {
    if (await hlKeyRefusal()) return null;
    const key = await getAgentKey();
    if (!key) return null;
    const meta = await getAgentMeta();
    const wallet = getSettings().wallet;
    if (!meta || agentRefusal(meta, wallet)) return null;
    if (!keyMatchesBinding(deriveAddress(key), meta, wallet)) return null;
    return key;
  } catch {
    return null;
  }
}

// The MFP read key: the view key when stored; on web, the trade key is
// also fine for reads (both are session-only there).
export async function mfpReadKey(): Promise<string | null> {
  try {
    const v = await getMfpKey("view");
    if (v) return v;
  } catch { /* fall through */ }
  if (Platform.OS === "web" && hasSessionMfpKey("trade")) {
    try { return await getMfpKey("trade"); } catch { return null; }
  }
  return null;
}

export async function mfpTradeKey(): Promise<string | null> {
  try { return await getMfpKey("trade"); } catch { return null; }
}

export async function mfpAccountId(): Promise<string | null> {
  const m = (await getMfpMeta("view")) ?? (await getMfpMeta("trade"));
  return m ? m.accountId : null;
}
