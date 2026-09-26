import {
  Home,
  History,
  Video,
  LineChart,
  Settings,
  Link2,
  Smartphone,
  HelpCircle,
  Mic,
  Briefcase,
  Bot,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  beta?: boolean;
}

/** Primary navigation stays in one uninterrupted list. Settings is a separate
 * dialog launcher, while mobile and help stay pinned to the sidebar bottom. */
export const primaryNavItems: NavItem[] = [
  { to: "/home", label: "Home", Icon: Home },
  { to: "/history", label: "History", Icon: History },
  { to: "/meetings", label: "Meetings", Icon: Video, beta: true },
  { to: "/interview", label: "Interview", Icon: Briefcase, beta: true },
  { to: "/agents", label: "Agents", Icon: Bot, beta: true },
  { to: "/insights", label: "Insights", Icon: LineChart },
  { to: "/dictation", label: "Dictation", Icon: Mic },
  { to: "/connectors", label: "Connectors", Icon: Link2 },
];

/** The routes the Agents page replaced. Never in the sidebar; they stay
 * routable because notification rows and deep links written before the merge
 * still carry them, and each redirects into the matching Agents tab. */
export const legacyAgentRoutes: NavItem[] = [
  { to: "/research", label: "Agents", Icon: Bot },
  { to: "/browser-agent", label: "Agents", Icon: Bot },
];

export const settingsNavItem: NavItem = {
  to: "/system",
  label: "Settings",
  Icon: Settings,
};

export const footerNavItems: NavItem[] = [
  { to: "/mobile", label: "Get the mobile app", Icon: Smartphone },
  { to: "/help", label: "Help", Icon: HelpCircle },
];

export const navSections = [
  { items: primaryNavItems },
  { items: footerNavItems },
];

/** Flat lookup of route -> label, for the top-bar title. */
export const navTitles: Record<string, string> = Object.fromEntries(
  [...primaryNavItems, ...legacyAgentRoutes, ...footerNavItems].map((item) => [item.to, item.label]),
);
navTitles["/interview"] = "Interview Companion";
