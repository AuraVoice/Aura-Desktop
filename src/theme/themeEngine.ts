import type { ThemeSetting } from "../lib/generalSettings";

export type ResolvedTheme = "light" | "dark";

/// Last theme this device painted. Every window shares the origin, so a window
/// that is opening can paint the right theme before React or the store are up.
const CACHE_KEY = "aura.theme.resolved";
/// Fallback crossfade length when View Transitions are missing. Matches the
/// ::view-transition duration in themes.css plus a frame of slack.
const FALLBACK_SWITCH_MS = 360;

type ViewTransitionHandle = { finished: Promise<void>; skipTransition: () => void };
type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionHandle;
};

let activeTransition: ViewTransitionHandle | null = null;
let fallbackTimer: number | null = null;

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/// Anything that is not an explicit "light" or "dark" follows the OS, so a
/// missing or corrupted stored value can never force a theme on anyone.
export function resolveTheme(setting: ThemeSetting | string | null | undefined): ResolvedTheme {
  if (setting === "light" || setting === "dark") return setting;
  return systemPrefersDark() ? "dark" : "light";
}

export function currentTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function paint(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Storage can be unavailable; the store reconcile still lands the theme.
  }
}

/// Synchronous, before the first render. Never animates.
export function bootTheme(): void {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(CACHE_KEY);
  } catch {
    cached = null;
  }
  paint(cached === "dark" || cached === "light" ? cached : resolveTheme("system"));
}

function motionAllowed(): boolean {
  if (document.hidden) return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return document.querySelector(".db-reduce-motion") === null;
}

export function applyTheme(theme: ResolvedTheme, { animate }: { animate: boolean }): void {
  if (document.documentElement.dataset.theme === theme) return;
  activeTransition?.skipTransition();

  if (!animate || !motionAllowed()) {
    paint(theme);
    return;
  }

  // A snapshot crossfade animates what CSS transitions cannot: gradients,
  // backdrop filters and pseudo-element sheens all fade together.
  const doc = document as TransitionDocument;
  if (typeof doc.startViewTransition === "function") {
    const transition = doc.startViewTransition(() => paint(theme));
    activeTransition = transition;
    void transition.finished.finally(() => {
      if (activeTransition === transition) activeTransition = null;
    });
    return;
  }

  const root = document.documentElement;
  root.classList.add("theme-switching");
  paint(theme);
  if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
  fallbackTimer = window.setTimeout(() => {
    root.classList.remove("theme-switching");
    fallbackTimer = null;
  }, FALLBACK_SWITCH_MS);
}
