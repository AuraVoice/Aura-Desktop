import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CONNECTOR_OAUTH_COMPLETE } from "../lib/ipcEvents";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConnectorReauthorizationRequiredError,
  disableGmail,
  disableGoogleCalendar,
  disableNotion,
  enableGmail,
  enableGoogleCalendar,
  enableNotion,
  fetchConnectors,
  startConnectorOAuth,
  syncGoogleCalendar,
  type ConnectorName,
  type ConnectorsCatalog,
  type GmailConnectorStatus,
  type GoogleCalendarConnectorStatus,
  type NotionConnectorStatus,
} from "../lib/connectors";
import { parseConnectorOAuthCompletion } from "../lib/connectorOAuth";
import { logError } from "../lib/log";

export type ConnectorAction =
  | "enabling"
  | "opening_browser"
  | "waiting_for_google"
  | "disabling"
  | "refreshing"
  | "enabling_gmail"
  | "opening_gmail"
  | "waiting_for_gmail"
  | "disabling_gmail"
  | "enabling_notion"
  | "opening_notion"
  | "waiting_for_notion"
  | "disabling_notion";

export interface ConnectorBanner {
  tone: "info" | "success" | "error";
  message: string;
}

export interface ConnectorsState {
  catalog: ConnectorsCatalog | null;
  loading: boolean;
  loadError: boolean;
  action: ConnectorAction | null;
  banner: ConnectorBanner | null;
  reload: () => Promise<void>;
  enableCalendar: () => Promise<void>;
  disableCalendar: () => Promise<void>;
  refreshCalendar: () => Promise<void>;
  enableGmail: () => Promise<void>;
  disableGmail: () => Promise<void>;
  enableNotion: () => Promise<void>;
  disableNotion: () => Promise<void>;
  clearBanner: () => void;
}

const OAUTH_EXPIRY_BANNER_MS = 3 * 60 * 1_000;

export function useConnectors(): ConnectorsState {
  const [catalog, setCatalog] = useState<ConnectorsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [action, setAction] = useState<ConnectorAction | null>(null);
  const [banner, setBanner] = useState<ConnectorBanner | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oauthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOAuthRef = useRef<{ attemptId: string; connector: ConnectorName } | null>(null);
  const handledAttemptsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  const clearBannerTimer = useCallback(() => {
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
  }, []);

  const clearOAuthWait = useCallback(() => {
    if (oauthTimerRef.current) {
      clearTimeout(oauthTimerRef.current);
      oauthTimerRef.current = null;
    }
    pendingOAuthRef.current = null;
  }, []);

  const waitForOAuth = useCallback((
    attemptId: string,
    connector: ConnectorName,
    expiresInSeconds: number,
  ) => {
    clearOAuthWait();
    pendingOAuthRef.current = { attemptId, connector };
    const providerName = connector === "notion" ? "Notion" : "Google";
    oauthTimerRef.current = setTimeout(() => {
      oauthTimerRef.current = null;
      pendingOAuthRef.current = null;
      if (!mountedRef.current) return;
      setAction(null);
      setBanner({
        tone: "info",
        message: `The ${providerName} connection window expired. Nothing changed, so you can try again.`,
      });
      bannerTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setBanner(null);
        bannerTimerRef.current = null;
      }, OAUTH_EXPIRY_BANNER_MS);
    }, Math.max(1, expiresInSeconds) * 1_000);
  }, [clearOAuthWait]);

  const applyCalendar = useCallback((calendar: GoogleCalendarConnectorStatus) => {
    if (!mountedRef.current) return;
    setCatalog((current) => current ? { ...current, googleCalendar: calendar } : current);
  }, []);

  const applyGmail = useCallback((gmail: GmailConnectorStatus) => {
    if (!mountedRef.current) return;
    setCatalog((current) => current ? { ...current, gmail } : current);
  }, []);

  const applyNotion = useCallback((notion: NotionConnectorStatus) => {
    if (!mountedRef.current) return;
    setCatalog((current) => current ? { ...current, notion } : current);
  }, []);

  const reload = useCallback(async () => {
    if (mountedRef.current) {
      setLoading(true);
      setLoadError(false);
    }
    try {
      const next = await fetchConnectors();
      if (mountedRef.current) setCatalog(next);
    } catch (err) {
      logError("useConnectors: load", err);
      if (mountedRef.current) setLoadError(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  /** The shared enable flow: try the saved connection, and on the 409
   * reauthorization contract hand off to the browser OAuth leg. This body
   * existed three times (Calendar, Gmail, Notion) with substituted strings;
   * a fix to its state handling now applies to every connector at once. */
  const runEnable = useCallback(async <Status,>(flow: {
    connector: ConnectorName;
    enablingAction: ConnectorAction;
    openingAction: ConnectorAction;
    waitingAction: ConnectorAction;
    enable: () => Promise<Status>;
    apply: (status: Status) => void;
    logLabel: string;
    checkingMessage: string;
    connectedMessage: string;
    enableFailedMessage: string;
    openingMessage: string;
    waitingMessage: string;
    openFailedMessage: string;
  }) => {
    if (action) return;
    clearBannerTimer();
    setAction(flow.enablingAction);
    setBanner({ tone: "info", message: flow.checkingMessage });
    try {
      const status = await flow.enable();
      if (!mountedRef.current) return;
      flow.apply(status);
      setAction(null);
      setBanner({ tone: "success", message: flow.connectedMessage });
    } catch (err) {
      if (!mountedRef.current) return;
      if (!(err instanceof ConnectorReauthorizationRequiredError)) {
        logError(`useConnectors: enable ${flow.logLabel}`, err);
        setAction(null);
        setBanner({ tone: "error", message: flow.enableFailedMessage });
        return;
      }

      setAction(flow.openingAction);
      setBanner({ tone: "info", message: flow.openingMessage });
      try {
        const authorization = await startConnectorOAuth(flow.connector);
        await openUrl(authorization.authorizationUrl);
        if (!mountedRef.current) return;
        waitForOAuth(
          authorization.attemptId,
          flow.connector,
          authorization.expiresInSeconds,
        );
        setAction(flow.waitingAction);
        setBanner({ tone: "info", message: flow.waitingMessage });
      } catch (openError) {
        logError(`useConnectors: open ${flow.logLabel} OAuth`, openError);
        setAction(null);
        setBanner({ tone: "error", message: flow.openFailedMessage });
      }
    }
  }, [action, clearBannerTimer, waitForOAuth]);

  /** The shared disable/refresh flow, same deduplication rationale. */
  const runAction = useCallback(async <Status,>(flow: {
    actionName: ConnectorAction;
    run: () => Promise<Status>;
    apply: (status: Status) => void;
    logLabel: string;
    startMessage: string;
    doneMessage: string;
    failedMessage: string;
    autoClearDoneMs?: number;
  }) => {
    if (action) return;
    clearBannerTimer();
    setAction(flow.actionName);
    setBanner({ tone: "info", message: flow.startMessage });
    try {
      const status = await flow.run();
      if (!mountedRef.current) return;
      flow.apply(status);
      setAction(null);
      setBanner({ tone: "success", message: flow.doneMessage });
      if (flow.autoClearDoneMs) {
        bannerTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setBanner(null);
          bannerTimerRef.current = null;
        }, flow.autoClearDoneMs);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      logError(`useConnectors: ${flow.logLabel}`, err);
      setAction(null);
      setBanner({ tone: "error", message: flow.failedMessage });
    }
  }, [action, clearBannerTimer]);

  const enableCalendar = useCallback(() => runEnable({
    connector: "google_calendar",
    enablingAction: "enabling",
    openingAction: "opening_browser",
    waitingAction: "waiting_for_google",
    enable: enableGoogleCalendar,
    apply: applyCalendar,
    logLabel: "Calendar",
    checkingMessage: "Checking your saved Google Calendar connection.",
    connectedMessage:
      "Now Buddy knows your story. Your connected data stays private and is only used to make Aura work for you.",
    enableFailedMessage: "Calendar could not connect just now. Nothing changed, so you can try again.",
    openingMessage: "Opening Google so you can reconnect Calendar securely.",
    waitingMessage: "Finish connecting in your browser. Aura will reopen here when it is done.",
    openFailedMessage: "The secure Google page could not open. Nothing changed, so you can try again.",
  }), [runEnable, applyCalendar]);

  const disableCalendar = useCallback(() => runAction({
    actionName: "disabling",
    run: disableGoogleCalendar,
    apply: applyCalendar,
    logLabel: "disable Calendar",
    startMessage: "Disconnecting Calendar and stopping active sync.",
    doneMessage: "Google Calendar is disconnected. You can reconnect anytime.",
    failedMessage: "Calendar stayed connected because the disconnect did not finish. Try again.",
  }), [runAction, applyCalendar]);

  const refreshCalendar = useCallback(() => runAction({
    actionName: "refreshing",
    run: syncGoogleCalendar,
    apply: applyCalendar,
    logLabel: "refresh Calendar",
    startMessage: "Checking Google Calendar for the latest events.",
    doneMessage: "Calendar is up to date. Buddy has the latest.",
    failedMessage: "Calendar could not refresh just now. Your last good sync is still safe.",
    autoClearDoneMs: 4_000,
  }), [runAction, applyCalendar]);

  const enableGmailConnector = useCallback(() => runEnable({
    connector: "gmail",
    enablingAction: "enabling_gmail",
    openingAction: "opening_gmail",
    waitingAction: "waiting_for_gmail",
    enable: enableGmail,
    apply: applyGmail,
    logLabel: "Gmail",
    checkingMessage: "Checking your saved Gmail connection.",
    connectedMessage: "Gmail is connected. Buddy can now help send email when you ask.",
    enableFailedMessage: "Gmail could not connect just now. Nothing changed, so you can try again.",
    openingMessage: "Opening Google so you can connect Gmail securely.",
    waitingMessage: "Finish connecting Gmail in your browser. Aura will reopen here when it is done.",
    openFailedMessage: "The secure Google page could not open. Nothing changed, so you can try again.",
  }), [runEnable, applyGmail]);

  const disableGmailConnector = useCallback(() => runAction({
    actionName: "disabling_gmail",
    run: disableGmail,
    apply: applyGmail,
    logLabel: "disable Gmail",
    startMessage: "Turning Gmail off for Buddy.",
    doneMessage: "Gmail is off. You can reconnect without consent while Google still allows it.",
    failedMessage: "Gmail stayed connected because the disconnect did not finish. Try again.",
  }), [runAction, applyGmail]);

  const enableNotionConnector = useCallback(() => runEnable({
    connector: "notion",
    enablingAction: "enabling_notion",
    openingAction: "opening_notion",
    waitingAction: "waiting_for_notion",
    enable: enableNotion,
    apply: applyNotion,
    logLabel: "Notion",
    checkingMessage: "Checking your saved Notion connection.",
    connectedMessage:
      "Notion is connected. Say where something on your screen should go and Buddy saves it there.",
    enableFailedMessage: "Notion could not connect just now. Nothing changed, so you can try again.",
    openingMessage: "Opening Notion so you can connect securely.",
    waitingMessage: "Finish connecting Notion in your browser. Aura will reopen here when it is done.",
    openFailedMessage: "The secure Notion page could not open. Nothing changed, so you can try again.",
  }), [runEnable, applyNotion]);

  const disableNotionConnector = useCallback(() => runAction({
    actionName: "disabling_notion",
    run: disableNotion,
    apply: applyNotion,
    logLabel: "disable Notion",
    startMessage: "Turning Notion off for Buddy.",
    doneMessage: "Notion is off. You can reconnect anytime.",
    failedMessage: "Notion stayed connected because the disconnect did not finish. Try again.",
  }), [runAction, applyNotion]);

  const handleOAuthCompletion = useCallback(async (rawUrl: string) => {
    const completion = parseConnectorOAuthCompletion(rawUrl);
    if (!completion || handledAttemptsRef.current.has(completion.attemptId)) return;
    const pending = pendingOAuthRef.current;
    if (
      pending
      && (
        pending.attemptId !== completion.attemptId
        || pending.connector !== completion.connector
      )
    ) {
      return;
    }
    handledAttemptsRef.current.add(completion.attemptId);
    clearOAuthWait();

    const providerName = completion.connector === "notion" ? "Notion" : "Google";
    if (completion.outcome !== "success") {
      if (!mountedRef.current) return;
      setAction(null);
      setBanner({
        tone: completion.outcome === "cancelled" ? "info" : "error",
        message: completion.outcome === "cancelled"
          ? `${providerName} connection was cancelled. Nothing changed.`
          : `${providerName} could not finish connecting. Nothing changed, so you can try again.`,
      });
      return;
    }

    try {
      const next = await fetchConnectors();
      if (!mountedRef.current) return;
      setCatalog(next);
      const connectedByName: Record<ConnectorName, boolean> = {
        google_calendar: next.googleCalendar.enabled,
        gmail: next.gmail.enabled,
        notion: next.notion.enabled,
      };
      const connectedMessage: Record<ConnectorName, string> = {
        google_calendar: "Google Calendar is connected. Buddy has the latest.",
        gmail: "Gmail is connected. Buddy can now help send email when you ask.",
        notion: "Notion is connected. Say where something on your screen should go and Buddy saves it there.",
      };
      setAction(null);
      setBanner(connectedByName[completion.connector]
        ? {
            tone: "success",
            message: connectedMessage[completion.connector],
          }
        : {
            tone: "error",
            message: `${providerName} finished, but Aura could not verify the connection. Refresh and try again.`,
          });
    } catch (err) {
      logError("useConnectors: OAuth completion refresh", err);
      if (!mountedRef.current) return;
      setAction(null);
      setBanner({
        tone: "error",
        message: "Aura could not verify the connection. Refresh and try again.",
      });
    }
  }, [clearOAuthWait]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    let unlisten: (() => void) | undefined;
    void listen<string>(CONNECTOR_OAUTH_COMPLETE, (event) => {
      void handleOAuthCompletion(event.payload);
      // Rust stashes the same URL for the fresh-webview handoff. When the
      // live listener already handled it, drain the stash too: the next
      // dashboard window mounts with an empty handledAttemptsRef, so a
      // lingering copy would replay a spurious "connected" banner.
      void invoke<string | null>("take_connector_oauth_completion").catch((err) =>
        logError("useConnectors: drain handled completion", err),
      );
    }).then(async (stopListening) => {
      unlisten = stopListening;
      const pending = await invoke<string | null>("take_connector_oauth_completion");
      if (pending) void handleOAuthCompletion(pending);
    }).catch((err) => logError("useConnectors: completion listener", err));
    return () => {
      mountedRef.current = false;
      clearBannerTimer();
      clearOAuthWait();
      unlisten?.();
    };
  }, [clearBannerTimer, clearOAuthWait, handleOAuthCompletion, reload]);

  return {
    catalog,
    loading,
    loadError,
    action,
    banner,
    reload,
    enableCalendar,
    disableCalendar,
    refreshCalendar,
    enableGmail: enableGmailConnector,
    disableGmail: disableGmailConnector,
    enableNotion: enableNotionConnector,
    disableNotion: disableNotionConnector,
    clearBanner: () => {
      clearBannerTimer();
      setBanner(null);
    },
  };
}
