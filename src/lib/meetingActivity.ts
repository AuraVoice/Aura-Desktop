import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "meeting-activity.json";
const OWNER_KEY = "owner_uid";
const ACTIVITIES_KEY = "activities";
const MAX_AGE_MS = 8 * 24 * 60 * 60_000;
const MAX_ROWS = 20;

export type MeetingActivityPhase =
  | "recording"
  | "saved_local"
  | "uploading"
  | "processing"
  | "ready"
  | "needs_attention"
  | "excluded"
  | "failed";

export interface MeetingActivity {
  meetingId: string;
  captureRunId?: string;
  eventId: string;
  phase: MeetingActivityPhase;
  segmentCount: number;
  uploadedCount: number;
  lastAttemptAt: number | null;
  nextRetryAt: number | null;
  failureCode: string | null;
  retryable: boolean;
  updatedAt: number;
}

let storeRef: Store | null = null;
let mutationTail: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

async function getStore(): Promise<Store> {
  return storeRef ?? (storeRef = await load(STORE_FILE));
}

function prune(rows: Record<string, MeetingActivity>): Record<string, MeetingActivity> {
  const cutoff = Date.now() - MAX_AGE_MS;
  return Object.fromEntries(
    Object.values(rows)
      .filter((row) => row.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ROWS)
      .map((row) => [row.meetingId, row]),
  );
}

export async function bindMeetingActivityOwner(uid: string): Promise<MeetingActivity[]> {
  return serialize(async () => {
    const store = await getStore();
    if ((await store.get<string>(OWNER_KEY)) !== uid) {
      await store.set(OWNER_KEY, uid);
      await store.set(ACTIVITIES_KEY, {});
      await store.save();
      return [];
    }
    const rows = prune(
      (await store.get<Record<string, MeetingActivity>>(ACTIVITIES_KEY)) ?? {},
    );
    return Object.values(rows).sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function upsertMeetingActivity(
  uid: string,
  activity: MeetingActivity,
): Promise<void> {
  return serialize(async () => {
    const store = await getStore();
    if ((await store.get<string>(OWNER_KEY)) !== uid) return;
    const rows = (await store.get<Record<string, MeetingActivity>>(ACTIVITIES_KEY)) ?? {};
    rows[activity.meetingId] = activity;
    await store.set(ACTIVITIES_KEY, prune(rows));
    await store.save();
  });
}
