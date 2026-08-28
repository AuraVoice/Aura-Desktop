import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { InterviewBrief } from "./interviewBrief";
import { INTERVIEW_BRIEF_UPDATED as BRIEF_EVENT } from "./ipcEvents";

export async function loadInterviewBrief(): Promise<InterviewBrief | null> {
  const brief = await invoke<InterviewBrief | null>("interview_hacker_brief");
  return brief?.contractVersion === 3 ? brief : null;
}

export function storeInterviewBrief(brief: InterviewBrief): Promise<void> {
  return invoke("set_interview_hacker_brief", { brief });
}

export function clearInterviewBrief(): Promise<void> {
  return invoke("clear_interview_hacker_brief");
}

export function listenForInterviewBrief(
  listener: (brief: InterviewBrief | null) => void,
): Promise<UnlistenFn> {
  return listen<InterviewBrief | null>(BRIEF_EVENT, (event) => {
    const brief = event.payload;
    listener(brief?.contractVersion === 3 ? brief : null);
  });
}
