import { getConversations, type ConversationSummary } from "../../lib/dashboardApi";
import { useAsyncData } from "../useAsyncData";
import { DataView } from "../DataView";
import { duration, shortDateTime } from "../format";

export function ConversationsPage() {
  const state = useAsyncData<ConversationSummary[]>(() => getConversations(30), "conversations");
  return (
    <div className="db-page">
      <DataView
        state={state}
        isEmpty={(items) => items.length === 0}
        emptyLabel="No conversations yet. Press Ctrl twice to start one."
        errorLabel="Conversation history will appear here once desktop history is available."
        showRetry={false}
      >
        {(items) => (
          <div className="db-list">
            {items.map((c) => (
              <div className="db-list-item" key={c.id}>
                <div className="db-list-meta">
                  {shortDateTime(c.startedAt)}
                  {c.durationSeconds != null ? ` · ${duration(c.durationSeconds)}` : ""}
                </div>
                <div className="db-list-title">{c.title}</div>
                {c.preview && <div className="db-list-sub">{c.preview}</div>}
              </div>
            ))}
          </div>
        )}
      </DataView>
    </div>
  );
}
