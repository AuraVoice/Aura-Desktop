import type { ConnectorName } from "./connectors";

const KNOWN_CONNECTORS: ReadonlySet<string> = new Set<ConnectorName>([
  "google_calendar",
  "gmail",
  "notion",
  "google_classroom",
  "github",
  "linkedin",
  "x",
]);

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
    || !connector
    || !KNOWN_CONNECTORS.has(connector)
    || (outcome !== "success" && outcome !== "cancelled" && outcome !== "failed")
  ) {
    return null;
  }
  return { attemptId, connector: connector as ConnectorName, outcome };
}
