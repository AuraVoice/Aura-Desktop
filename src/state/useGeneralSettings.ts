import { useEffect, useState } from "react";
import {
  DEFAULT_GENERAL_SETTINGS,
  loadGeneralSettings,
  subscribeGeneralSettings,
  type GeneralSettings,
} from "../lib/generalSettings";
import { logError } from "../lib/log";

export function useGeneralSettings(): GeneralSettings {
  const [settings, setSettings] = useState(DEFAULT_GENERAL_SETTINGS);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    loadGeneralSettings().then((value) => {
      if (active) setSettings(value);
    });
    subscribeGeneralSettings((value) => {
      if (active) setSettings(value);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("useGeneralSettings: subscribe", err));

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return settings;
}
