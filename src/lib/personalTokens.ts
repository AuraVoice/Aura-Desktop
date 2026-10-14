import { API_BASE_URL, authFetchWithTimeout } from "./api";

/**
 * Personal access tokens for coding agents (juno-backend
 * services/personal_tokens.py). A token reads the user's meetings through the
 * hosted MCP server at /user-mcp and nothing else; the secret is returned
 * once, at mint, and only its hash is stored.
 */

export const USER_MCP_URL = `${API_BASE_URL}/user-mcp`;

export interface PersonalToken {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
}

const TIMEOUT_MS = 15_000;

export class PersonalTokenError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`personal token request failed: ${code}`);
    this.code = code;
  }
}

async function codeOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { detail?: { code?: unknown } } | null;
  return typeof body?.detail?.code === "string" ? body.detail.code : `http_${response.status}`;
}

export async function listPersonalTokens(): Promise<PersonalToken[]> {
  const response = await authFetchWithTimeout("/devices/tokens", undefined, TIMEOUT_MS);
  if (!response.ok) throw new PersonalTokenError(await codeOf(response));
  const body = (await response.json()) as { items?: unknown };
  return Array.isArray(body.items)
    ? body.items.flatMap((raw) => {
        const row = raw as Record<string, unknown> | null;
        return row && typeof row.id === "string"
          ? [{
              id: row.id,
              label: typeof row.label === "string" ? row.label : "",
              createdAt: typeof row.created_at === "string" ? row.created_at : "",
              lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : "",
            }]
          : [];
      })
    : [];
}

/** The one time the secret is visible. */
export async function mintPersonalToken(label: string): Promise<{ id: string; token: string }> {
  const response = await authFetchWithTimeout(
    "/devices/tokens",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) },
    TIMEOUT_MS,
  );
  if (!response.ok) throw new PersonalTokenError(await codeOf(response));
  const body = (await response.json()) as { id?: unknown; token?: unknown };
  if (typeof body.id !== "string" || typeof body.token !== "string") {
    throw new PersonalTokenError("malformed_response");
  }
  return { id: body.id, token: body.token };
}

export async function revokePersonalToken(id: string): Promise<void> {
  const response = await authFetchWithTimeout(
    `/devices/tokens/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    TIMEOUT_MS,
  );
  if (!response.ok && response.status !== 404) throw new PersonalTokenError(await codeOf(response));
}

/** Setup lines per agent, with the token filled in. */
export function agentSetup(token: string): { agent: string; text: string }[] {
  return [
    {
      agent: "Claude Code",
      text: `claude mcp add --transport http aura ${USER_MCP_URL} --header "Authorization: Bearer ${token}"`,
    },
    {
      agent: "Cursor",
      text: JSON.stringify(
        { mcpServers: { aura: { url: USER_MCP_URL, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      ),
    },
    {
      agent: "Codex",
      text: `[mcp_servers.aura]\nurl = "${USER_MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${token}" }`,
    },
  ];
}
