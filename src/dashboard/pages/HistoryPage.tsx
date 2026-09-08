import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AudioLines, Bookmark, FileText } from "lucide-react";
import { SlidingTabs, useTabStage, type SlidingTab } from "../components/SlidingTabs";
import { ConversationsPanel } from "./ConversationsPanel";
import { DraftsPanel } from "./DraftsPanel";
import { SavedPanel } from "./SavedPanel";

export type HistoryTab = "conversations" | "drafts" | "saved";

const HISTORY_TABS: Array<SlidingTab<HistoryTab>> = [
  { value: "conversations", label: "Conversations", Icon: AudioLines },
  { value: "drafts", label: "Drafts", Icon: FileText },
  { value: "saved", label: "Saved", Icon: Bookmark },
];

const LAST_TAB_KEY = "aura.dashboard.history-tab";

function isHistoryTab(value: string | null | undefined): value is HistoryTab {
  return HISTORY_TABS.some((tab) => tab.value === value);
}

/** Route to the History page with the given section open. */
export function historyPath(tab: HistoryTab): string {
  return `/history?tab=${tab}`;
}

function rememberedTab(): HistoryTab {
  try {
    const stored = globalThis.localStorage?.getItem(LAST_TAB_KEY);
    if (isHistoryTab(stored)) return stored;
  } catch {
    // Storage can be unavailable; the default below is fine.
  }
  return "conversations";
}

function rememberTab(tab: HistoryTab) {
  try {
    globalThis.localStorage?.setItem(LAST_TAB_KEY, tab);
  } catch {
    // Best effort only.
  }
}

/** One page for the three cross-surface data sets. A `?tab=` param (from Home
 * page links) wins, then the last section the user was on, then Conversations. */
export function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get("tab");
  const [initialTab] = useState<HistoryTab>(() => (isHistoryTab(paramTab) ? paramTab : rememberedTab()));
  const stage = useTabStage<HistoryTab>(initialTab);

  // The hash can change while the page is mounted (a Home link or the native
  // dashboard-navigate event); follow it the same way a pill click would.
  useEffect(() => {
    if (isHistoryTab(paramTab) && paramTab !== stage.tab) {
      stage.switchTab(paramTab);
      rememberTab(paramTab);
    }
    // stage.switchTab is recreated every render; only the param matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramTab]);

  const select = (tab: HistoryTab) => {
    stage.switchTab(tab);
    rememberTab(tab);
    setSearchParams({ tab }, { replace: true });
  };

  const width = stage.renderedTab === "saved" ? "db-page-full" : "db-page-wide";

  return (
    <div className={`db-page db-history-page ${width}`}>
      <SlidingTabs
        tabs={HISTORY_TABS}
        value={stage.tab}
        onChange={select}
        ariaLabel="History"
        idPrefix="history"
      />
      <div className={`db-tab-stage is-${stage.transition}`}>
        <div
          role="tabpanel"
          id={`history-${stage.renderedTab}-panel`}
          aria-labelledby={`history-${stage.renderedTab}-tab`}
        >
          {stage.renderedTab === "saved" ? (
            <SavedPanel />
          ) : stage.renderedTab === "drafts" ? (
            <DraftsPanel />
          ) : (
            <ConversationsPanel />
          )}
        </div>
      </div>
    </div>
  );
}
