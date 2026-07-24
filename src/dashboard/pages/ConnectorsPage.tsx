import {
  CalendarDays,
  Check,
  Mail,
  MessagesSquare,
  Notebook,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  loadConnectorInterest,
  saveConnectorInterest,
  type ConnectorInterest,
  type FutureConnectorId,
} from "../../lib/connectorPreferences";
import {
  loadGeneralSettings,
  saveGeneralSettings,
  type GeneralSettings,
} from "../../lib/generalSettings";
import { fetchUpcomingMeetings, type UpcomingMeetings } from "../../lib/calendar";
import { logError } from "../../lib/log";
import { useAsyncData } from "../useAsyncData";

const FUTURE_CONNECTORS: Array<{
  id: FutureConnectorId;
  Icon: LucideIcon;
  name: string;
  copy: string;
  featured?: boolean;
}> = [
  {
    id: "gmail",
    Icon: Mail,
    name: "Gmail",
    copy: "Draft, review, and follow up on email with Aura.",
    featured: true,
  },
  {
    id: "slack",
    Icon: MessagesSquare,
    name: "Slack",
    copy: "Turn conversations into clear updates and replies.",
  },
  {
    id: "notion",
    Icon: Notebook,
    name: "Notion",
    copy: "Save useful Aura output directly into your workspace.",
  },
];

export function ConnectorsPage() {
  const navigate = useNavigate();
  const calendar = useAsyncData<UpcomingMeetings | null>(
    () => fetchUpcomingMeetings(10_000),
    "calendar connection",
  );
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [interest, setInterest] = useState<ConnectorInterest>({});
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    Promise.all([loadGeneralSettings(), loadConnectorInterest()])
      .then(([savedSettings, savedInterest]) => {
        setSettings(savedSettings);
        setInterest(savedInterest);
      })
      .catch((err) => logError("ConnectorsPage: load preferences", err));
  }, []);

  async function updateCalendarSetting(
    key: "calendarInBriefing" | "calendarOverlay",
    checked: boolean,
  ) {
    if (!settings) return;
    const previous = settings;
    const next = { ...settings, [key]: checked };
    setSettings(next);
    setSaveError(false);
    try {
      await saveGeneralSettings(next);
    } catch (err) {
      setSettings(previous);
      setSaveError(true);
      logError("ConnectorsPage: save calendar setting", err);
    }
  }

  async function toggleInterest(id: FutureConnectorId) {
    const previous = interest;
    const next = { ...interest, [id]: !interest[id] };
    setInterest(next);
    setSaveError(false);
    try {
      await saveConnectorInterest(next);
    } catch (err) {
      setInterest(previous);
      setSaveError(true);
      logError("ConnectorsPage: save connector interest", err);
    }
  }

  const calendarData = calendar.data;
  const connected = calendarData?.connected === true;
  const eventCount = calendarData?.events.length ?? 0;
  const unavailable = !calendar.loading && calendarData === null;

  return (
    <div className="db-page db-page-wide db-connectors-page">
      <header className="db-connectors-intro">
        <div>
          <h2>Bring your work into Aura</h2>
          <p>Choose what Aura can use to prepare your day and help in the moment.</p>
        </div>
        <span className="db-connectors-count">
          {connected ? "1 connected" : "No apps connected"}
        </span>
      </header>

      <section className="db-connectors-section">
        <div className="db-connectors-section-heading">
          <h3>Available now</h3>
          <p>Connection status comes from your Aura account.</p>
        </div>

        <article className={`db-panel db-connector-card db-connector-card-live${
          connected ? " is-connected" : ""
        }`}>
          <div className="db-connector-head">
            <span className="db-connector-icon db-connector-icon-google">
              <CalendarDays size={23} aria-hidden />
            </span>
            <span className={`db-connector-status${
              connected ? " is-connected" : unavailable ? " is-unavailable" : ""
            }`}>
              {calendar.loading
                ? "Checking"
                : connected
                  ? "Connected"
                  : unavailable
                    ? "Unavailable"
                    : "Not connected"}
            </span>
          </div>

          <div className="db-connector-live-copy">
            <div>
              <h2>Google Calendar</h2>
              <p className="db-muted">
                {calendar.loading
                  ? "Checking your Aura account for Calendar access."
                  : connected
                    ? eventCount > 0
                      ? `${eventCount} upcoming event${
                        eventCount === 1 ? "" : "s"
                      } found today.`
                      : "Connected, with no more events today."
                    : unavailable
                      ? "Aura could not verify Calendar right now. Your saved connection was not changed."
                      : "Connect from Aura mobile, then refresh this page."}
              </p>
            </div>

            <div className="db-connector-actions">
              {connected ? (
                <button type="button" className="db-primary-btn" onClick={() => navigate("/home")}>
                  View today
                </button>
              ) : (
                <button type="button" className="db-primary-btn" onClick={() => navigate("/mobile")}>
                  Set up on mobile
                </button>
              )}
              <button
                type="button"
                className="db-secondary-btn"
                onClick={calendar.reload}
                disabled={calendar.loading}
              >
                <RefreshCw size={15} aria-hidden />
                Refresh status
              </button>
            </div>
          </div>

          <div className="db-connector-options" aria-label="Google Calendar display options">
            <ConnectorToggle
              label="Show in daily briefing"
              description="Include upcoming events in Today."
              checked={settings?.calendarInBriefing ?? true}
              disabled={!connected || settings === null}
              onChange={(checked) => void updateCalendarSetting("calendarInBriefing", checked)}
            />
            <ConnectorToggle
              label="Show in desktop overlay"
              description="Let Aura surface relevant calendar context."
              checked={settings?.calendarOverlay ?? true}
              disabled={!connected || settings === null}
              onChange={(checked) => void updateCalendarSetting("calendarOverlay", checked)}
            />
          </div>
        </article>
      </section>

      <section className="db-connectors-section">
        <div className="db-connectors-section-heading">
          <h3>Coming next</h3>
          <p>Mark the integrations you would use. Your choices stay on this device.</p>
        </div>
        <div className="db-connector-grid">
          {FUTURE_CONNECTORS.map((connector) => (
            <FutureConnector
              key={connector.id}
              {...connector}
              interested={interest[connector.id] === true}
              onToggle={() => void toggleInterest(connector.id)}
            />
          ))}
        </div>
      </section>

      {saveError && (
        <p className="db-connectors-error">
          That preference could not be saved. Your previous choice was restored.
        </p>
      )}
    </div>
  );
}

function ConnectorToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`db-connector-toggle${disabled ? " is-disabled" : ""}`}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        className="db-setting-toggle"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function FutureConnector({
  Icon,
  name,
  copy,
  featured,
  interested,
  onToggle,
}: {
  Icon: LucideIcon;
  name: string;
  copy: string;
  featured?: boolean;
  interested: boolean;
  onToggle: () => void;
}) {
  return (
    <article className={`db-panel db-connector-card db-connector-card-future${
      featured ? " is-featured" : ""
    }`}>
      <div className="db-connector-head">
        <span className="db-connector-icon"><Icon size={21} aria-hidden /></span>
        <span className="db-connector-status db-connector-status-future">
          {featured ? "Featured" : "Coming soon"}
        </span>
      </div>
      <h2>{name}</h2>
      <p className="db-muted">{copy}</p>
      <button
        type="button"
        className={`db-connector-interest${interested ? " is-active" : ""}`}
        aria-pressed={interested}
        onClick={onToggle}
      >
        {interested && <Check size={14} aria-hidden />}
        {interested ? "Interested" : "I'm interested"}
      </button>
    </article>
  );
}
