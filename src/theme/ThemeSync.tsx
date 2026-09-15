import { useEffect } from "react";
import {
  loadGeneralSettings,
  subscribeGeneralSettings,
  type ThemeSetting,
} from "../lib/generalSettings";
import { logError } from "../lib/log";
import { applyTheme, resolveTheme } from "./themeEngine";

/**
 * Keeps this window's <html data-theme> in step with the Appearance setting and,
 * while that setting is System, with the OS. Mounted once per window in main.tsx.
 *
 * It reads the store itself rather than through useGeneralSettings, because that
 * hook starts from the defaults: resolving "system" before the real value loads
 * would flash the OS theme over a user who chose the other one.
 */
export function ThemeSync() {
  useEffect(() => {
    let active = true;
    let setting: ThemeSetting | null = null;
    let unlisten: (() => void) | undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const sync = (animate: boolean) => {
      if (setting !== null) applyTheme(resolveTheme(setting), { animate });
    };

    loadGeneralSettings().then((settings) => {
      // A change event can beat the initial load; the newer value wins.
      if (!active || setting !== null) return;
      setting = settings.theme;
      sync(false);
    });
    subscribeGeneralSettings((settings) => {
      if (!active) return;
      setting = settings.theme;
      sync(true);
    })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((err) => logError("ThemeSync: subscribe", err));

    const onSystemChange = () => sync(true);
    media.addEventListener("change", onSystemChange);

    return () => {
      active = false;
      unlisten?.();
      media.removeEventListener("change", onSystemChange);
    };
  }, []);

  return null;
}
