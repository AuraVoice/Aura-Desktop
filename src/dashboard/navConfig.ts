import {
  Home,
  AudioLines,
  FileText,
  Bookmark,
  Video,
  LineChart,
  Settings,
  Link2,
  Smartphone,
  HelpCircle,
  Mic,
  Search,
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
  { to: "/conversations", label: "Conversations", Icon: AudioLines },
  { to: "/drafts", label: "Drafts", Icon: FileText },
  { to: "/saved", label: "Saved", Icon: Bookmark },
  { to: "/meetings", label: "Meetings", Icon: Video, beta: true },
  { to: "/research", label: "Research", Icon: Search, beta: true },
  { to: "/insights", label: "Insights", Icon: LineChart },
  { to: "/dictation", label: "Dictation", Icon: Mic },
  { to: "/connectors", label: "Connectors", Icon: Link2 },
];

export const settingsNavItem: NavItem = {
  to: "/general",
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
  [...primaryNavItems, ...footerNavItems].map((item) => [item.to, item.label]),
);
