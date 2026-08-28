import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { INTERVIEW_RESUME_UPDATED as RESUME_EVENT } from "./ipcEvents";

/**
 * The resume the overlay's preflight can attach when no reviewed brief exists.
 *
 * Deliberately the same shape as interviewBriefMemory: a process-wide Rust slot
 * rather than window-local state, so the dictation/overlay/dashboard windows all
 * see one answer, and sign-out clears it with the brief (clear_preparation).
 * In memory only - a resume is not written to disk by this path.
 */

export async function loadInterviewResume(): Promise<string | null> {
  const resume = await invoke<string | null>("interview_resume");
  return resume && resume.trim() ? resume : null;
}

export function storeInterviewResume(resume: string): Promise<void> {
  return invoke("set_interview_resume", { resume });
}

export function clearInterviewResume(): Promise<void> {
  return invoke("clear_interview_resume");
}

export function listenForInterviewResume(
  listener: (resume: string | null) => void,
): Promise<UnlistenFn> {
  return listen<string | null>(RESUME_EVENT, (event) => {
    const resume = event.payload;
    listener(resume && resume.trim() ? resume : null);
  });
}
