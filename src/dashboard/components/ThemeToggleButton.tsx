import { Moon, Sun } from "lucide-react";
import { setThemeSetting } from "../../lib/generalSettings";
import { logError } from "../../lib/log";
import { applyTheme } from "../../theme/themeEngine";
import { useResolvedTheme } from "../../theme/useResolvedTheme";
import "./ThemeToggleButton.css";

/**
 * Top bar shortcut between Light and Dark. It always flips what is on screen
 * right now, so on System it picks the opposite of the OS and pins it; System
 * itself is chosen from Settings > System > Appearance.
 */
export function ThemeToggleButton() {
  const resolved = useResolvedTheme();
  const next = resolved === "dark" ? "light" : "dark";

  async function toggle() {
    const previous = resolved;
    // Paint first so the crossfade starts on the click, not after a store
    // round trip. ThemeSync sees the saved value and finds nothing to do.
    applyTheme(next, { animate: true });
    try {
      await setThemeSetting(next);
    } catch (err) {
      logError("ThemeToggleButton: save theme", err);
      applyTheme(previous, { animate: true });
    }
  }

  return (
    <button
      type="button"
      className={`db-icon-btn db-theme-toggle is-${resolved}`}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => void toggle()}
    >
      <Sun size={20} className="db-theme-toggle-sun" aria-hidden />
      <Moon size={19} className="db-theme-toggle-moon" aria-hidden />
    </button>
  );
}
