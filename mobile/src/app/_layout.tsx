// Root layout: three tabs, dark-only (trading surface).
import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState } from "react-native";

import { initNotifications, syncFavoritesToPush } from "@/lib/push";
import { C } from "@/theme";

// Module scope per expo-notifications docs: the foreground handler must be
// set before any notification arrives, not inside a component lifecycle.
initNotifications();

export default function RootLayout() {
  // Re-register (token + favorites) on cold start AND whenever the app
  // returns to the foreground. Star toggles sync immediately, but a toggle
  // made while offline is silently swallowed, and Android keeps this app
  // resident for days - foreground re-sync is what keeps the worker's
  // favorites-only alert scope tracking the stars. No-op until the user
  // registers once in Settings.
  useEffect(() => {
    syncFavoritesToPush();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") syncFavoritesToPush();
    });
    return () => sub.remove();
  }, []);
  return (
    <>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: C.card,
            borderTopColor: "rgba(255,255,255,0.08)",
          },
          tabBarActiveTintColor: C.bull,
          tabBarInactiveTintColor: C.faint,
          sceneStyle: { backgroundColor: C.bg },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Screener",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="pulse" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="portfolio"
          options={{
            title: "Portfolio",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="wallet-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="settings-outline" color={color} size={size} />
            ),
          }}
        />
      </Tabs>
    </>
  );
}
