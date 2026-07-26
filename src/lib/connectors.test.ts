import { describe, expect, it } from "vitest";
import { parseConnectorsCatalog } from "./connectors";

describe("parseConnectorsCatalog", () => {
  it("maps the backend connector contract without exposing credentials", () => {
    const catalog = parseConnectorsCatalog({
      google_calendar: {
        enabled: false,
        can_reconnect: true,
        watch_active: false,
        calendar_name: "Work",
        last_synced_at: "2026-07-25T20:00:00+00:00",
      },
      gmail: {
        enabled: false,
        can_reconnect: true,
        email_address: "person@example.com",
      },
    });

    expect(catalog.googleCalendar).toMatchObject({
      enabled: false,
      canReconnect: true,
      calendarName: "Work",
      lastSyncedAt: "2026-07-25T20:00:00+00:00",
    });
    expect(catalog.gmail).toMatchObject({
      enabled: false,
      canReconnect: true,
      emailAddress: "person@example.com",
    });
    expect(catalog).not.toHaveProperty("refresh_token");
  });

  it("uses safe disconnected defaults for a partial response", () => {
    const catalog = parseConnectorsCatalog({});

    expect(catalog.googleCalendar.enabled).toBe(false);
    expect(catalog.googleCalendar.canReconnect).toBe(false);
    expect(catalog.googleCalendar.calendarName).toBe("Primary");
    expect(catalog.gmail.enabled).toBe(false);
    expect(catalog.gmail.canReconnect).toBe(false);
  });
});
