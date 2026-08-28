import { useTauriEvent } from "../lib/useTauriEvent";
import {
  GUIDE_ARMED,
  SCREEN_SIGHT_ARMED,
  type GuideArmedPayload,
  type ScreenSightArmedPayload,
} from "../lib/ipcEvents";
import { showStatusPill } from "../lib/statusPill";

export function useStatusPillEvents(): void {
  useTauriEvent<ScreenSightArmedPayload>(
    SCREEN_SIGHT_ARMED,
    (payload) => {
      showStatusPill(payload.armed ? "screen-sight-on" : "screen-sight-off");
    },
    "useStatusPillEvents: screen sight",
  );

  useTauriEvent<GuideArmedPayload>(
    GUIDE_ARMED,
    (payload) => {
      showStatusPill(payload.armed ? "guide-on" : "guide-off");
    },
    "useStatusPillEvents: guide",
  );
}
