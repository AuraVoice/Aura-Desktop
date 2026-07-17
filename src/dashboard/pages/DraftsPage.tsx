import { DataView } from "../DataView";
import { useAsyncData } from "../useAsyncData";
import type { DraftChannel } from "../../lib/draft";

type DashboardDraft = {
  channel: DraftChannel;
};

export function DraftsPage() {
  // draft.ts refines active companion drafts. It has no durable list endpoint,
  // so this remains an honest empty surface until that contract is available.
  const state = useAsyncData(async () => [] as DashboardDraft[], "drafts");

  return (
    <div className="db-page">
      <DataView
        state={state}
        isEmpty={(drafts) => drafts.length === 0}
        emptyLabel="Drafts created during a conversation appear in the Aura companion."
      >
        {() => null}
      </DataView>
    </div>
  );
}
