import { useEffect, useState } from "react";

/**
 * Subscribes to a CSS media query so a layout can be a real branch in React,
 * not just a `display: none` the screen reader still walks.
 *
 * The dashboard is otherwise CSS-only about breakpoints, and it should stay
 * that way for anything purely visual. This exists for the one case CSS cannot
 * express: below the split-pane width the meeting detail mounts a single pane
 * behind a tab strip, and the pane that is not selected must be absent, not
 * hidden - `SlidingTabs` wires `aria-controls` to a panel that has to exist.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query)?.matches === true,
  );

  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
