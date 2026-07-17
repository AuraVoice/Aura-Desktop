import { getSavedItems, type SavedItem } from "../../lib/dashboardApi";
import { useAsyncData } from "../useAsyncData";
import { DataView } from "../DataView";
import { shortDateTime } from "../format";

export function SavedPage() {
  const state = useAsyncData<SavedItem[]>(() => getSavedItems(50), "saved items");
  return (
    <div className="db-page">
      <DataView
        state={state}
        isEmpty={(items) => items.length === 0}
        emptyLabel="Nothing saved yet. Ask Aura to remember something."
        errorLabel="Saved items will appear here once desktop history is available."
        showRetry={false}
      >
        {(items) => (
          <div className="db-list">
            {items.map((item) => (
              <div className="db-list-item" key={item.id}>
                <div className="db-list-meta">{shortDateTime(item.savedAt)}</div>
                <div className="db-list-title">{item.label}</div>
                {item.value && <div className="db-list-sub">{item.value}</div>}
              </div>
            ))}
          </div>
        )}
      </DataView>
    </div>
  );
}
