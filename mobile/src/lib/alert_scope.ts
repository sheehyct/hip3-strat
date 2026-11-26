// Worker alert scope, recorded from /api/state polls (same choke-point idiom
// as display_parity.ts: every consumer polls through fetchState, so no screen
// can forget to note it; Settings reads the latest value on mount).
//
// Two additive fields ride the payload:
//   alertUniverses        which universes the worker alerts on at all.
//                         [] is a REAL value (alerting on nothing).
//   alert_favs_universes  universes that alert ONLY for push-registered
//                         favorites. A coin there
//                         alerts on transitions AFTER it is starred - the
//                         baseline on scope entry is silent by design.
//
// A missing field (older worker) is UNKNOWN, per the display_v convention:
// render nothing, never warn - an older worker image is a
// supported configuration.

export type AlertScope = {
  /** null = no payload yet, or a worker that does not serve the field. */
  alertUniverses: string[] | null;
  favsOnlyUniverses: string[] | null;
};

let scope: AlertScope = { alertUniverses: null, favsOnlyUniverses: null };

export function noteAlertScope(
  alertUniverses: string[] | undefined,
  favsOnly: string[] | undefined,
): void {
  scope = {
    alertUniverses: Array.isArray(alertUniverses) ? alertUniverses : scope.alertUniverses,
    favsOnlyUniverses: Array.isArray(favsOnly) ? favsOnly : scope.favsOnlyUniverses,
  };
}

export function getAlertScope(): AlertScope {
  return scope;
}

/**
 * One human line for Settings, or null when the worker never told us.
 * Examples: "worker alerts: xyz", "worker alerts: xyz + perps
 * (perps favorites-only)", "worker alerts: none".
 */
export function alertScopeLine(s: AlertScope = scope): string | null {
  if (s.alertUniverses === null) return null;
  if (s.alertUniverses.length === 0) return "worker alerts: none";
  const favsOnly = s.favsOnlyUniverses ?? [];
  const parts = s.alertUniverses.map((u) =>
    favsOnly.includes(u) ? u + " (favorites-only)" : u,
  );
  return "worker alerts: " + parts.join(" + ");
}
