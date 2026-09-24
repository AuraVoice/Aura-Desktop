/**
 * Which ambient-call app ids can be one conversation. Mirrors the hand-off
 * pairs in `src-tauri/src/meeting/detect.rs` (`same_call`): a Zoom join
 * walks browser-call (the launcher page holding the mic) -> zoom-web -> zoom,
 * a Teams join does the same through teams-web, and any browser-hosted call
 * is reported as browser-call whenever its tab is hidden. The detector keeps
 * the capture on one key across those; this is the React side's memory of
 * the same fact, for the prompt's "already recorded" cooldown and for
 * rejoining a claim after a leave.
 */
const FAMILIES: ReadonlyArray<ReadonlyArray<string>> = [
  ["zoom", "zoom-web", "browser-call"],
  ["teams", "teams-web", "browser-call"],
  ["webex", "browser-call"],
  ["google-meet", "browser-call"],
];

/** `app` and every app id a call in `app` can be re-reported as. */
export function relatedCallApps(app: string): string[] {
  const related = new Set<string>([app]);
  for (const family of FAMILIES) {
    if (family.includes(app)) family.forEach((member) => related.add(member));
  }
  return [...related];
}

export function sameCallFamily(a: string, b: string): boolean {
  return relatedCallApps(a).includes(b);
}
