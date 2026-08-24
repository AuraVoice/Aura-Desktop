import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { InterviewBrief } from "./interviewBrief";

const BRIEF_EVENT = "interview-brief-updated";

export function loadInterviewBrief(): Promise<InterviewBrief | null> {
  return invoke<InterviewBrief | null>("interview_companion_brief");
}

export function storeInterviewBrief(brief: InterviewBrief): Promise<void> {
  return invoke("set_interview_companion_brief", { brief });
}

export function listenForInterviewBrief(
  listener: (brief: InterviewBrief | null) => void,
): Promise<UnlistenFn> {
  return listen<InterviewBrief | null>(BRIEF_EVENT, (event) => listener(event.payload));
}
