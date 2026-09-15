import type { ComponentType } from "react";
import type { AccountConnectorName, AccountConnectorStatus } from "./connectors";
import {
  GitHubBrandIcon,
  GoogleClassroomBrandIcon,
  LinkedInBrandIcon,
  XBrandIcon,
} from "../dashboard/components/connectorBrandIcons";

/**
 * Descriptors for the connectors that share one status shape and one
 * enable/disable flow. Adding a connector of this kind means one entry here,
 * one backend OAuth2Connector subclass, and nothing hand-copied across the
 * Connectors page, useConnectors and the OAuth completion parser.
 *
 * Calendar, Gmail and Notion keep their hand-written rows on purpose: they
 * shipped first, and moving them onto this table is a separate change.
 */
export interface AccountConnectorDescriptor {
  name: AccountConnectorName;
  label: string;
  /** Used in "Opening {providerName}..." and cancellation copy. */
  providerName: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  pitch: string;
  connectedDetail: (status: AccountConnectorStatus) => string;
  connectedMessage: string;
  openingMessage: string;
  waitingMessage: string;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export const ACCOUNT_CONNECTORS: readonly AccountConnectorDescriptor[] = [
  {
    name: "github",
    label: "GitHub",
    providerName: "GitHub",
    Icon: GitHubBrandIcon,
    pitch: "Ask why a build is red, see PRs waiting on you, and file issues you approve.",
    connectedDetail: (status) => status.accountLabel ?? "Connected account",
    connectedMessage:
      "GitHub is connected. If Buddy can't see a repository yet, choose it with Choose repositories.",
    openingMessage: "Opening GitHub so you can connect securely.",
    waitingMessage: "Finish connecting GitHub in your browser. Aura reopens here when it is done.",
  },
  {
    name: "linkedin",
    label: "LinkedIn",
    providerName: "LinkedIn",
    Icon: LinkedInBrandIcon,
    pitch: "Post your LinkedIn drafts after you check them. Aura never posts on its own.",
    connectedDetail: (status) => {
      const expires = formatDate(status.expiresAt);
      const name = status.accountLabel ?? "Connected account";
      return expires ? `${name} - reconnect by ${expires}` : name;
    },
    connectedMessage: "LinkedIn is connected. Drafts get a Post button, and nothing goes out until you click it.",
    openingMessage: "Opening LinkedIn so you can connect securely.",
    waitingMessage: "Finish connecting LinkedIn in your browser. Aura reopens here when it is done.",
  },
  {
    name: "x",
    label: "X",
    providerName: "X",
    Icon: XBrandIcon,
    pitch: "Ask Buddy about posts you bookmarked, and post drafts after you check them.",
    connectedDetail: (status) => {
      const account = status.accountLabel ?? "Connected account";
      return status.bookmarkCount !== null ? `${account} - ${status.bookmarkCount} bookmarks` : account;
    },
    connectedMessage: "X is connected. Aura is pulling in your bookmarks so Buddy can find them.",
    openingMessage: "Opening X so you can connect securely.",
    waitingMessage: "Finish connecting X in your browser. Aura reopens here when it is done.",
  },
  {
    name: "google_classroom",
    label: "Google Classroom",
    providerName: "Google",
    Icon: GoogleClassroomBrandIcon,
    pitch: "Ask what's due this week and Buddy checks your classes.",
    connectedDetail: (status) => status.accountLabel ?? "Your classes",
    connectedMessage: "Google Classroom is connected. Ask Buddy what's due this week.",
    openingMessage: "Opening Google so you can connect Classroom securely.",
    waitingMessage: "Finish connecting Classroom in your browser. Aura reopens here when it is done.",
  },
];

export const ACCOUNT_CONNECTOR_BY_NAME: Record<AccountConnectorName, AccountConnectorDescriptor> =
  Object.fromEntries(ACCOUNT_CONNECTORS.map((descriptor) => [descriptor.name, descriptor])) as Record<
    AccountConnectorName,
    AccountConnectorDescriptor
  >;
