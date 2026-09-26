import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Globe, Search } from "lucide-react";
import { SlidingTabs, useTabStage, type SlidingTab } from "../components/SlidingTabs";
import { BrowserAgentPage } from "./BrowserAgentPage";
import { ResearchPage } from "./ResearchPage";

export type AgentTab = "computer" | "research";

const AGENT_TABS: Array<SlidingTab<AgentTab>> = [
  { value: "computer", label: "Computer", Icon: Globe },
  { value: "research", label: "Research", Icon: Search },
];

const LAST_TAB_KEY = "aura.dashboard.agents-tab";

export function isAgentTab(value: string | null | undefined): value is AgentTab {
  return AGENT_TABS.some((tab) => tab.value === value);
}

/** Route to the Agents page with one agent open, and optionally one of its runs. */
export function agentsPath(tab: AgentTab, runId?: string | null): string {
  return runId ? `/agents?tab=${tab}&run=${encodeURIComponent(runId)}` : `/agents?tab=${tab}`;
}

function rememberedTab(): AgentTab {
  try {
    const stored = globalThis.localStorage?.getItem(LAST_TAB_KEY);
    if (isAgentTab(stored)) return stored;
  } catch {
    // Storage can be unavailable; the default below is fine.
  }
  return "research";
}

function rememberTab(tab: AgentTab) {
  try {
    globalThis.localStorage?.setItem(LAST_TAB_KEY, tab);
  } catch {
    // Best effort only.
  }
}

/** The two background agents behind one sidebar entry. Each tab keeps its own
 * composer, live list and library; `?tab=` (from notifications, the notch
 * result card and old deep links) wins, then the last tab the user was on,
 * then Research. Both panels read `?run=` for the row to open. */
export function AgentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get("tab");
  const [initialTab] = useState<AgentTab>(() => (isAgentTab(paramTab) ? paramTab : rememberedTab()));
  const stage = useTabStage<AgentTab>(initialTab);

  // The hash can change while the page is mounted (the native dashboard-navigate
  // event); follow it the same way a pill click would.
  useEffect(() => {
    if (isAgentTab(paramTab) && paramTab !== stage.tab) {
      stage.switchTab(paramTab);
      rememberTab(paramTab);
    }
    // stage.switchTab is recreated every render; only the param matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramTab]);

  // A tab switch closes any open run: `tab` is the only param that survives.
  const select = (tab: AgentTab) => {
    stage.switchTab(tab);
    rememberTab(tab);
    setSearchParams({ tab }, { replace: true });
  };

  return (
    <div className="db-page db-page-wide db-agents-page">
      <SlidingTabs
        tabs={AGENT_TABS}
        value={stage.tab}
        onChange={select}
        ariaLabel="Agents"
        idPrefix="agents"
      />
      <div className={`db-tab-stage is-${stage.transition}`}>
        <div
          role="tabpanel"
          id={`agents-${stage.renderedTab}-panel`}
          aria-labelledby={`agents-${stage.renderedTab}-tab`}
        >
          {stage.renderedTab === "computer" ? <BrowserAgentPage /> : <ResearchPage />}
        </div>
      </div>
    </div>
  );
}

/** The retired `/research` and `/browser-agent` routes. Notification rows and
 * deep links written before the merge still carry them, with `?run=`. */
export function LegacyAgentRedirect({ tab }: { tab: AgentTab }) {
  const [searchParams] = useSearchParams();
  return <Navigate to={agentsPath(tab, searchParams.get("run"))} replace />;
}
