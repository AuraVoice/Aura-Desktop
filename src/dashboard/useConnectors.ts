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

  const enableCalendar = useCallback(async () => {
    if (action) return;
    clearBannerTimer();
    setAction("enabling");
    setBanner({
      tone: "info",
      message: "Checking your saved Google Calendar connection.",
    });
    try {
      const calendar = await enableGoogleCalendar();
      if (!mountedRef.current) return;
      applyCalendar(calendar);
      setAction(null);
      setBanner({
        tone: "success",
        message:
          "Now Buddy knows your story. Your connected data stays private and is only used to make Aura work for you.",
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (!(err instanceof ConnectorReauthorizationRequiredError)) {
        logError("useConnectors: enable Calendar", err);
        setAction(null);
        setBanner({
          tone: "error",
          message: "Calendar could not connect just now. Nothing changed, so you can try again.",
        });
        return;
      }

      setAction("opening_browser");
      setBanner({
        tone: "info",
        message: "Opening Google so you can reconnect Calendar securely.",
      });
      try {
        const authorization = await startConnectorOAuth("google_calendar");
        await openUrl(authorization.authorizationUrl);
        if (!mountedRef.current) return;
        waitForOAuth(
          authorization.attemptId,
          "google_calendar",
          authorization.expiresInSeconds,
        );
        setAction("waiting_for_google");
        setBanner({
          tone: "info",
          message: "Finish connecting in your browser. Aura will reopen here when it is done.",
        });
      } catch (openError) {
        logError("useConnectors: open Calendar OAuth", openError);
        setAction(null);
        setBanner({
          tone: "error",
          message: "The secure Google page could not open. Nothing changed, so you can try again.",
        });
      }
    }
  }, [action, applyCalendar, clearBannerTimer, waitForOAuth]);

  const disableCalendar = useCallback(async () => {
    if (action) return;
    clearBannerTimer();
    setAction("disabling");
    setBanner({
      tone: "info",
      message: "Disconnecting Calendar and stopping active sync.",
    });
    try {
      const calendar = await disableGoogleCalendar();
      if (!mountedRef.current) return;
      applyCalendar(calendar);
      setAction(null);
      setBanner({
        tone: "success",
        message: "Google Calendar is disconnected. You can reconnect anytime.",
      });
    } catch (err) {
      if (!mountedRef.current) return;
      logError("useConnectors: disable Calendar", err);
      setAction(null);
      setBanner({
        tone: "error",
        message: "Calendar stayed connected because the disconnect did not finish. Try again.",
      });
    }
  }, [action, applyCalendar, clearBannerTimer]);

  const refreshCalendar = useCallback(async () => {
    if (action) return;
    clearBannerTimer();
    setAction("refreshing");
    setBanner({
      tone: "info",
      message: "Checking Google Calendar for the latest events.",
    });
    try {
      const calendar = await syncGoogleCalendar();
      if (!mountedRef.current) return;
      applyCalendar(calendar);
      setAction(null);
      setBanner({
        tone: "success",
        message: "Calendar is up to date. Buddy has the latest.",
      });
      bannerTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setBanner(null);
        bannerTimerRef.current = null;
      }, 4_000);
    } catch (err) {
      if (!mountedRef.current) return;
      logError("useConnectors: refresh Calendar", err);
      setAction(null);
      setBanner({
        tone: "error",
        message: "Calendar could not refresh just now. Your last good sync is still safe.",
      });
    }
  }, [action, applyCalendar, clearBannerTimer]);

  const enableGmailConnector = useCallback(async () => {
    if (action) return;
    clearBannerTimer();
    setAction("enabling_gmail");
    setBanner({ tone: "info", message: "Checking your saved Gmail connection." });
    try {
      const gmail = await enableGmail();
      if (!mountedRef.current) return;
      applyGmail(gmail);
      setAction(null);
      setBanner({
        tone: "success",
        message: "Gmail is connected. Buddy can now help send email when you ask.",
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (!(err instanceof ConnectorReauthorizationRequiredError)) {
        logError("useConnectors: enable Gmail", err);
        setAction(null);
        setBanner({
          tone: "error",
          message: "Gmail could not connect just now. Nothing changed, so you can try again.",
        });
        return;
      }

      setAction("opening_gmail");
      setBanner({ tone: "info", message: "Opening Google so you can connect Gmail securely." });
      try {
        const authorization = await startConnectorOAuth("gmail");
        await openUrl(authorization.authorizationUrl);
        if (!mountedRef.current) return;
        waitForOAuth(
          authorization.attemptId,
          "gmail",
          authorization.expiresInSeconds,
        );
        setAction("waiting_for_gmail");
        setBanner({
          tone: "info",
          message: "Finish connecting Gmail in your browser. Aura will reopen here when it is done.",
        });
      } catch (openError) {
        logError("useConnectors: open Gmail OAuth", openError);
        setAction(null);
        setBanner({
          tone: "error",
          message: "The secure Google page could not open. Nothing changed, so you can try again.",
        });
      }
    }
  }, [action, applyGmail, clearBannerTimer, waitForOAuth]);

  const disableGmailConnector = useCallback(async () => {
    if (action) return;
    clearBannerTimer();
    setAction("disabling_gmail");
    setBanner({ tone: "info", message: "Turning Gmail off for Buddy." });
    try {
      const gmail = await disableGmail();
      if (!mountedRef.current) return;
      applyGmail(gmail);
      setAction(null);
      setBanner({
        tone: "success",
        message: "Gmail is off. You can reconnect without consent while Google still allows it.",
      });
    } catch (err) {
      if (!mountedRef.current) return;
      logError("useConnectors: disable Gmail", err);
      setAction(null);
      setBanner({
        tone: "error",
        message: "Gmail stayed connected because the disconnect did not finish. Try again.",
      });
    }
  }, [action, applyGmail, clearBannerTimer]);

  const enableNotionConnector = useCallback(async () => {
    if (action) return;
    clearBannerTimer();
    setAction("enabling_notion");
    setBanner({ tone: "info", message: "Checking your saved Notion connection." });
    try {
      const notion = await enableNotion();
      if (!mountedRef.current) return;
      applyNotion(notion);
      setAction(null);
      setBanner({
        tone: "success",
        message: "Notion is connected. Say where something on your screen should go and Buddy saves it there.",
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (!(err instanceof ConnectorReauthorizationRequiredError)) {
        logError("useConnectors: enable Notion", err);
        setAction(null);
        setBanner({
          tone: "error",
          message: "Notion could not connect just now. Nothing changed, so you can try again.",
        });
        return;
      }

      setAction("opening_notion");
      setBanner({ tone: "info", message: "Opening Notion so you can connect securely." });
      try {
        const authorization = await startConnectorOAuth("notion");
        await openUrl(authorization.authorizationUrl);
        if (!mountedRef.current) return;
        waitForOAuth(
          authorization.attemptId,
          "notion",
          authorization.expiresInSeconds,
        );
        setAction("waiting_for_notion");
        setBanner({
          tone: "info",
          message: "Finish connecting Notion in your browser. Aura will reopen here when it is done.",
        });
      } catch (openError) {
        logError("useConnectors: open Notion OAuth", openError);
        setAction(null);
        setBanner({
          tone: "error",
          message: "The secure Notion page could not open. Nothing changed, so you can try again.",
        });
      }
    }
  }, [action, applyNotion, clearBannerTimer, waitForOAuth]);

  const disableNotionConnector = useCallback(async () => {
    if (action) return;
    clearBannerTimer();
    setAction("disabling_notion");
    setBanner({ tone: "info", message: "Turning Notion off for Buddy." });
    try {
      const notion = await disableNotion();
      if (!mountedRef.current) return;
      applyNotion(notion);
      setAction(null);
      setBanner({
        tone: "success",
        message: "Notion is off. You can reconnect anytime.",
      });
    } catch (err) {
      if (!mountedRef.current) return;
      logError("useConnectors: disable Notion", err);
      setAction(null);
      setBanner({
        tone: "error",
        message: "Notion stayed connected because the disconnect did not finish. Try again.",
      });
    }
  }, [action, applyNotion, clearBannerTimer]);

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
