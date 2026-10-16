import { useCallback, useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy } from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import { logError } from "../../lib/log";
import {
  agentSetup,
  listPersonalTokens,
  mintPersonalToken,
  PersonalTokenError,
  revokePersonalToken,
  type PersonalToken,
} from "../../lib/personalTokens";

/** A prompt chevron and cursor, drawn to the brand icons' 28px box. */
function AgentGlyph() {
  return (
    <svg width={26} height={26} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="19" height="16" rx="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 10l3 2.5L7 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15.5H17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

/**
 * Settings > Connectors > Coding agents: lets Claude Code, Cursor or Codex
 * read the user's meeting notes through Aura's hosted MCP server. Connect
 * mints a personal token and shows it once inside ready-to-paste setup lines;
 * the list below names each token by when it was made and last used, and
 * Revoke stops it within a minute.
 */
export function CodingAgentsRow() {
  const [tokens, setTokens] = useState<PersonalToken[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [agent, setAgent] = useState(0);

  const load = useCallback(() => {
    listPersonalTokens()
      .then(setTokens)
      .catch((err) => {
        logError("CodingAgentsRow: list", err);
        setTokens([]);
      });
  }, []);
  useEffect(load, [load]);

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      // The time tells two same-day connections apart, so Revoke hits the right one.
      const madeAt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
      const minted = await mintPersonalToken(`Coding agent · ${madeAt}`);
      setFresh(minted.token);
      setAgent(0);
      trackEvent("coding_agent_token_created", {});
      load();
    } catch (err) {
      logError("CodingAgentsRow: mint", err);
      setError(
        err instanceof PersonalTokenError && err.code === "token_limit_reached"
          ? "You have 10 connections. Revoke one first."
          : "Aura couldn't create a connection. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await revokePersonalToken(id);
      trackEvent("coding_agent_token_revoked", {});
      load();
    } catch (err) {
      logError("CodingAgentsRow: revoke", err);
      setError("Aura couldn't revoke that. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const copy = (key: string, text: string) => {
    void writeText(text)
      .then(() => {
        setCopied(key);
        window.setTimeout(() => setCopied(null), 1500);
      })
      .catch((err) => logError("CodingAgentsRow: copy", err));
  };

  return (
    <article className={`db-panel db-connector-row db-coding-agents${tokens?.length ? " is-connected" : ""}`}>
      <span className="db-connector-icon">
        <AgentGlyph />
      </span>
      <div className="db-connector-row-copy">
        <div className="db-connector-title-line">
          <h2>Coding agents</h2>
        </div>
        <p>Let Claude Code, Cursor or Codex read your meeting notes. Read only, and you can revoke it anytime.</p>
        {fresh && (() => {
          const setups = agentSetup(fresh);
          const shown = setups[agent] ?? setups[0];
          return (
            <div className="db-agent-setup">
              <p className="db-connector-attention">Copy this now. Aura shows the key only once.</p>
              <div className="db-agent-terminal">
                <div className="db-agent-terminal-bar" role="tablist" aria-label="Coding agent">
                  {setups.map((setup, index) => (
                    <button
                      key={setup.agent}
                      type="button"
                      role="tab"
                      aria-selected={index === agent}
                      className={index === agent ? "db-agent-tab is-active" : "db-agent-tab"}
                      onClick={() => setAgent(index)}
                    >
                      {setup.agent}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="db-agent-copy"
                    aria-label={`Copy the ${shown.agent} setup`}
                    onClick={() => copy(shown.agent, shown.text)}
                  >
                    {copied === shown.agent ? <Check size={14} /> : <Copy size={14} />}
                    {copied === shown.agent ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="db-agent-code">{shown.text}</pre>
              </div>
              <button type="button" className="db-agent-done" onClick={() => setFresh(null)}>
                Done, hide the key
              </button>
            </div>
          );
        })()}
        {tokens && tokens.length > 0 && (
          <ul className="db-agent-tokens">
            {tokens.map((token) => (
              <li key={token.id}>
                <span className="db-agent-token-dot" aria-hidden="true" />
                <span className="db-agent-token-copy">
                  <strong>{token.label}</strong>
                  <span>
                    Made {shortDate(token.createdAt)}
                    {token.lastUsedAt ? `, last used ${shortDate(token.lastUsedAt)}` : ", not used yet"}
                  </span>
                </span>
                <button type="button" className="db-agent-revoke" disabled={busy} onClick={() => void revoke(token.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="db-connector-attention" role="alert">{error}</p>}
      </div>
      <div className="db-connector-row-controls">
        <button type="button" className="db-secondary-btn" disabled={busy} onClick={() => void connect()}>
          Connect
        </button>
      </div>
    </article>
  );
}
