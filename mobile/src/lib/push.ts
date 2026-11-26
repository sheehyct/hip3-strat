// Expo push registration against the scanner worker. The worker sends
// alerts through the Expo Push Service (FCM under the hood); this module only
// registers a delivery endpoint - the app NEVER detects (project contract).
//
// Favorites scoping: the registration carries the starred syms, so the worker
// pushes only those coins' alerts to this device. No favorites = every alert
// the worker's profile fires.
//
// The worker's token store is ephemeral (lost on each redeploy), so
// registration is re-synced quietly on every app open and after every star
// toggle - registration is idempotent server-side.
//
// Receiving on Android requires an EAS build with FCM V1 credentials
// (Expo Go cannot receive remote push) - see "Push notifications" in the
// README.

import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  getFavorites,
  getPushKey,
  getPushToken,
  getWorkerUrl,
  setPushToken,
} from "./store";

// Show notifications while the app is foregrounded (the default drops them).
// Called once at module scope from the root layout, per expo-notifications docs.
export function initNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

function post(url: string, key: string, body: unknown): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-push-key": key },
    body: JSON.stringify(body),
    signal: ctl.signal,
  }).finally(() => clearTimeout(t));
}

async function easProjectId(): Promise<string | null> {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    null
  );
}

// Registers this device with the worker. Never throws - every failure comes
// back as the human-readable status line shown in Settings.
export async function registerForPush(): Promise<string> {
  try {
    if (!Device.isDevice) return "push needs a physical device";
    const key = await getPushKey();
    if (!key) return "enter the worker push key first";

    // Android 8+ delivers through channels; MAX importance = heads-up banner.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "STRAT alerts",
        importance: Notifications.AndroidImportance.MAX,
      });
    }

    let perm = await Notifications.getPermissionsAsync();
    if (perm.status !== "granted") {
      perm = await Notifications.requestPermissionsAsync();
    }
    if (perm.status !== "granted") return "notification permission denied";

    const projectId = await easProjectId();
    if (!projectId) return "missing EAS projectId - run 'eas init' and rebuild";

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    const favs = await getFavorites();
    const base = await getWorkerUrl();
    const r = await post(base + "/api/push/register", key, { token, favs });
    if (r.status === 401) return "worker rejected the push key";
    if (r.status === 403) return "push registration is disabled on the worker";
    if (!r.ok) return "register failed: HTTP " + r.status;
    await setPushToken(token);
    return favs.length
      ? "registered - scoped to " + favs.length + " favorite" + (favs.length === 1 ? "" : "s")
      : "registered - receiving ALL worker alerts";
  } catch (e) {
    return "register failed: " + (e instanceof Error ? e.message : String(e));
  }
}

export async function unregisterPush(): Promise<string> {
  try {
    const token = await getPushToken();
    if (!token) return "this device is not registered";
    const key = await getPushKey();
    const base = await getWorkerUrl();
    const r = await post(base + "/api/push/unregister", key, { token });
    // 404 = the worker already forgot it (redeploy wiped the store) - done.
    if (r.ok || r.status === 404) {
      await setPushToken("");
      return "unregistered";
    }
    return "unregister failed: HTTP " + r.status;
  } catch (e) {
    return "unregister failed: " + (e instanceof Error ? e.message : String(e));
  }
}

// Quiet re-sync: refreshes the registration (token + current favorites) if
// this device has registered before. Failures are swallowed - the next app
// open or manual register catches up. Runs on app open and after star toggles.
export async function syncFavoritesToPush(): Promise<void> {
  try {
    const token = await getPushToken();
    const key = await getPushKey();
    if (!token || !key) return;
    const favs = await getFavorites();
    const base = await getWorkerUrl();
    await post(base + "/api/push/register", key, { token, favs });
  } catch {
    // offline or worker mid-restart - nothing to do, re-sync happens later
  }
}
