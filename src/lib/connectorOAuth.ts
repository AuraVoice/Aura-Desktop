import type { ConnectorName } from "./connectors";

export interface ConnectorOAuthCompletion {
  attemptId: string;
  connector: ConnectorName;
  outcome: "success" | "cancelled" | "failed";
}

export function parseConnectorOAuthCompletion(
  rawUrl: string,
): ConnectorOAuthCompletion | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "aura:"
    || url.hostname !== "connectors"
    || url.pathname !== "/complete"
  ) {
    return null;
  }

  const attemptId = url.searchParams.get("attempt_id");
  const connector = url.searchParams.get("connector");
  const outcome = url.searchParams.get("outcome");
  if (
    !attemptId
    || (connector !== "google_calendar" && connector !== "gmail")
    || (outcome !== "success" && outcome !== "cancelled" && outcome !== "failed")
  ) {
    return null;
  }
  return { attemptId, connector, outcome };
}
