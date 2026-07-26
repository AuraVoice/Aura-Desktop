import { RefreshCw } from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import type {
  GmailConnectorStatus,
  GoogleCalendarConnectorStatus,
} from "../../lib/connectors";
import {
  GmailBrandIcon,
  GoogleCalendarBrandIcon,
  NotionBrandIcon,
  SlackBrandIcon,
} from "../components/connectorBrandIcons";
import {
  useConnectors,
  type ConnectorBanner,
} from "../useConnectors";

const COMING_SOON_CONNECTORS: Array<{
  id: "gmail" | "slack" | "notion";
  Icon: ComponentType<{ size?: number; className?: string }>;
  name: string;
  copy: string;
}> = [
  {
    id: "slack",
    Icon: SlackBrandIcon,
    name: "Slack",
    copy: "Keep Buddy in the loop with your team conversations.",
  },
  {
    id: "notion",
    Icon: NotionBrandIcon,
    name: "Notion",
    copy: "Bring your notes and pages into what Buddy knows.",
  },
];

export function ConnectorsPage() {
  const connectors = useConnectors();
  const [confirmDisconnect, setConfirmDisconnect] = useState<"calendar" | "gmail" | null>(null);
  const calendar = connectors.catalog?.googleCalendar ?? null;
  const gmail = connectors.catalog?.gmail ?? null;
  const calendarConnected = calendar?.enabled === true;
  const gmailConnected = gmail?.enabled === true;
  const busy = connectors.loading || connectors.action !== null;

  return (
    <div className="db-page db-connectors-page">
      <header className="db-connectors-intro">
        <div>
          <h2>Your connections</h2>
          <p>Bring the apps you already use into Buddy's world.</p>
        </div>
      </header>

      {connectors.loadError && !connectors.catalog ? (
        <div className="db-panel db-connectors-load-error" role="alert">
          <p>Connections could not load just now.</p>
          <button
            type="button"
            className="db-secondary-btn"
            onClick={() => void connectors.reload()}
          >
            Try again
          </button>
        </div>
      ) : (
        <section
          className={`db-connectors-stack${connectors.loading ? " is-loading" : ""}`}
          aria-busy={connectors.loading || busy}
        >
          <CalendarConnectorRow
            calendar={calendar}
            connected={calendarConnected}
            busy={busy}
            refreshing={connectors.action === "refreshing"}
            onToggle={(checked) => {
              if (checked) {
                setConfirmDisconnect(null);
                void connectors.enableCalendar();
              } else {
                connectors.clearBanner();
                setConfirmDisconnect("calendar");
              }
            }}
            onRefresh={() => void connectors.refreshCalendar()}
          />

          <GmailConnectorRow
            gmail={gmail}
            connected={gmailConnected}
            busy={busy}
            onToggle={(checked) => {
              if (checked) {
                setConfirmDisconnect(null);
                void connectors.enableGmail();
              } else {
                connectors.clearBanner();
                setConfirmDisconnect("gmail");
              }
            }}
          />

          {confirmDisconnect && (
            <div
              className="db-connector-banner is-confirm"
              role="alertdialog"
              aria-labelledby="connector-disconnect-title"
            >
              <div>
                <strong id="connector-disconnect-title">Leave Buddy hanging?</strong>
                <p>
                  Are you sure you want to disconnect{" "}
                  {confirmDisconnect === "calendar" ? "Google Calendar" : "Gmail"}?
                  Buddy will stop using it, but you can reconnect anytime.
                </p>
              </div>
              <div className="db-connector-banner-actions">
                <button
                  type="button"
                  className="db-secondary-btn"
                  onClick={() => setConfirmDisconnect(null)}
                >
                  Keep connected
                </button>
                <button
                  type="button"
                  className="db-primary-btn"
                  onClick={() => {
                    const target = confirmDisconnect;
                    setConfirmDisconnect(null);
                    if (target === "calendar") {
                      void connectors.disableCalendar();
                    } else {
                      void connectors.disableGmail();
                    }
                  }}
                >
                  Disconnect
                </button>
              </div>
            </div>
          )}

          {confirmDisconnect === null && connectors.banner && (
            <ActionBanner banner={connectors.banner} />
          )}

          {COMING_SOON_CONNECTORS.map((connector) => (
            <ComingSoonConnector key={connector.id} {...connector} />
          ))}
        </section>
      )}
    </div>
  );
}

function CalendarConnectorRow({
  calendar,
  connected,
  busy,
  refreshing,
  onToggle,
  onRefresh,
}: {
  calendar: GoogleCalendarConnectorStatus | null;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  onToggle: (checked: boolean) => void;
  onRefresh: () => void;
}) {
  const lastSync = formatLastSync(calendar?.lastSyncedAt ?? null);
  return (
    <article className={`db-panel db-connector-row${connected ? " is-connected" : ""}`}>
      <span className="db-connector-icon db-connector-icon-google">
        <GoogleCalendarBrandIcon size={28} />
      </span>
      <div className="db-connector-row-copy">
        <div className="db-connector-title-line">
          <h2>Google Calendar</h2>
          {connected && <span className="db-connector-connected-dot">Connected</span>}
        </div>
        <p>
          {connected
            ? `${calendar?.calendarName ?? "Primary"} calendar${lastSync ? ` - ${lastSync}` : ""}`
            : "Let Buddy check your schedule and keep your day in sync."}
        </p>
      </div>
      <div className="db-connector-row-controls">
        {connected && (
          <button
            type="button"
            className={`db-connector-refresh${refreshing ? " is-refreshing" : ""}`}
            onClick={onRefresh}
            disabled={busy}
            aria-label="Refresh Google Calendar"
            title="Refresh Google Calendar"
          >
            <RefreshCw size={17} aria-hidden />
          </button>
        )}
        <ConnectorSwitch
          connected={connected}
          busy={busy}
          name="Google Calendar"
          onToggle={onToggle}
        />
      </div>
    </article>
  );
}

function ConnectorSwitch({
  connected,
  busy,
  name,
  onToggle,
}: {
  connected: boolean;
  busy: boolean;
  name: string;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label className="db-connector-switch">
      <span className="db-sr-only">
        {connected ? `Disconnect ${name}` : `Connect ${name}`}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={connected}
        disabled={busy}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span className="db-connector-switch-track" aria-hidden>
        <span />
      </span>
    </label>
  );
}

function GmailConnectorRow({
  gmail,
  connected,
  busy,
  onToggle,
}: {
  gmail: GmailConnectorStatus | null;
  connected: boolean;
  busy: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <article className={`db-panel db-connector-row${connected ? " is-connected" : ""}`}>
      <span className="db-connector-icon">
        <GmailBrandIcon size={28} />
      </span>
      <div className="db-connector-row-copy">
        <div className="db-connector-title-line">
          <h2>Gmail</h2>
          {connected && <span className="db-connector-connected-dot">Connected</span>}
        </div>
        <p>
          {connected
            ? gmail?.emailAddress ?? "Connected mailbox"
            : "Let Buddy send email for you when you ask."}
        </p>
      </div>
      <div className="db-connector-row-controls">
        <ConnectorSwitch
          connected={connected}
          busy={busy}
          name="Gmail"
          onToggle={onToggle}
        />
      </div>
    </article>
  );
}

function ComingSoonConnector({
  Icon,
  name,
  copy,
}: {
  Icon: ComponentType<{ size?: number; className?: string }>;
  name: string;
  copy: string;
}) {
  return (
    <article className="db-panel db-connector-row">
      <span className="db-connector-icon">
        <Icon size={21} aria-hidden />
      </span>
      <div className="db-connector-row-copy">
        <h2>{name}</h2>
        <p>{copy}</p>
      </div>
      <span className="db-connector-coming-soon">Coming soon</span>
    </article>
  );
}

function ActionBanner({ banner }: { banner: ConnectorBanner }) {
  return (
    <div
      className={`db-connector-banner is-${banner.tone}`}
      role={banner.tone === "error" ? "alert" : "status"}
    >
      <p>{banner.message}</p>
    </div>
  );
}

function formatLastSync(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}
