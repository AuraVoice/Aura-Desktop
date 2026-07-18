import {
  Home,
  MessageSquare,
  FileText,
  Bookmark,
  LineChart,
  BookOpen,
  Code2,
  Type,
  Settings,
  Link2,
  User,
  CreditCard,
  Activity,
  Smartphone,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
}

export interface NavSection {
  heading?: string;
  items: NavItem[];
}

/** Sidebar structure for the dashboard window. Order and grouping match the
 * approved design. Home, Conversations, Drafts, Saved, and the account/settings
 * group are real pages; the Tools group still routes to a "coming soon"
 * placeholder. */
export const navSections: NavSection[] = [
  {
    items: [
      { to: "/home", label: "Home", Icon: Home },
      { to: "/conversations", label: "Conversations", Icon: MessageSquare },
      { to: "/drafts", label: "Drafts", Icon: FileText },
      { to: "/saved", label: "Saved", Icon: Bookmark },
    ],
  },
  {
    heading: "Tools",
    items: [
      { to: "/insights", label: "Insights", Icon: LineChart },
      { to: "/dictionary", label: "Dictionary", Icon: BookOpen },
      { to: "/snippets", label: "Snippets", Icon: Code2 },
      { to: "/style", label: "Style", Icon: Type },
    ],
  },
  {
    heading: "Settings",
    items: [
      { to: "/general", label: "General", Icon: Settings },
      { to: "/connectors", label: "Connectors", Icon: Link2 },
      { to: "/account", label: "Account", Icon: User },
      { to: "/billing", label: "Billing", Icon: CreditCard },
      { to: "/usage", label: "Usage", Icon: Activity },
    ],
  },
  {
    items: [
      { to: "/mobile", label: "Get the mobile app", Icon: Smartphone },
      { to: "/help", label: "Help", Icon: HelpCircle },
    ],
  },
];

/** Flat lookup of route -> label, for the top-bar title. */
export const navTitles: Record<string, string> = Object.fromEntries(
  navSections.flatMap((section) => section.items.map((item) => [item.to, item.label])),
);
