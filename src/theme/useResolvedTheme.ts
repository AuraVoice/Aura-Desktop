import { useEffect, useState } from "react";
import { currentTheme, type ResolvedTheme } from "./themeEngine";

/** The theme this window is painting right now. Watches <html data-theme>
 * directly, so it follows the setting, the OS and other windows alike. */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setTheme(currentTheme());
    return () => observer.disconnect();
  }, []);

  return theme;
}
