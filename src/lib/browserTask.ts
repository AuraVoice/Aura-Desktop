import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";
import type { BrowserTaskStatusPayload } from "./ipcEvents";

/**
 * Typed client for the Background Browser Agent (src-tauri/src/agent_browser).
 *
 * Rust owns the browser, the loop and the task record; this file only names
 * the commands. The one credential that crosses here is the Firebase ID token
 * the overlay's refresh pump hands Rust for the `/agent/step` call, the same
 * React-mints-Rust-holds arrangement as dictation's polish and command calls.
 */

/** Mirrors agent_browser/store.rs TaskSummary (rename_all = "camelCase"). */
export interface BrowserTaskSummary {
  taskId: string;
  origin: string;
  state: string;
  steps: number;
  startedAtMs: number;
  endedAtMs: number;
  failureCode: string | null;
  partial: boolean;
  brief: string;
  sourceCount: number;
}

/** Mirrors agent_browser/store.rs TraceEntry. */
export interface BrowserTaskTraceEntry {
  step: number;
  action: string;
  refId: string;
  url: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  result: string;
  model: string;
}

/** Mirrors agent_browser/store.rs TaskDetail. */
export interface BrowserTaskDetail {
  taskId: string;
  origin: string;
  state: string;
  steps: number;
  startedAtMs: number;
  endedAtMs: number;
  failureCode: string | null;
  partial: boolean;
  brief: string;
  answer: string;
  sources: string[];
  trace: BrowserTaskTraceEntry[];
}

export function startBrowserTask(brief: string, origin: "dashboard" | "voice" | "dictation" = "dashboard") {
  return invoke<BrowserTaskStatusPayload>("browser_task_start", { brief, origin });
}

export function stopBrowserTask() {
  return invoke<BrowserTaskStatusPayload>("browser_task_stop");
}

export function approveBrowserTask(allow: boolean) {
  return invoke<void>("browser_task_approve", { allow });
}

export function watchBrowserTask() {
  return invoke<void>("browser_task_watch");
}

export function browserTaskStatus() {
  return invoke<BrowserTaskStatusPayload>("browser_task_status");
}

export function loadBrowserTaskConsent() {
  return invoke<boolean>("browser_task_consent");
}

export function setBrowserTaskConsent(accepted: boolean) {
  return invoke<boolean>("set_browser_task_consent", { accepted });
}

export function listBrowserTasks(uid: string) {
  return invoke<BrowserTaskSummary[]>("browser_tasks_list", { uid });
}

export function loadBrowserTask(uid: string, taskId: string) {
  return invoke<BrowserTaskDetail | null>("browser_task_load", { uid, taskId });
}

export function deleteBrowserTask(uid: string, taskId: string) {
  return invoke<void>("browser_task_delete", { uid, taskId });
}

/** Hands Rust a fresh Firebase ID token, RAM only on its side. */
export async function pushBrowserTaskCredential(idToken: string, ttlSeconds: number): Promise<void> {
  await invoke("browser_task_set_credential", { idToken, ttlSeconds: Math.floor(ttlSeconds) });
}

export async function clearBrowserTaskCredential(): Promise<void> {
  try {
    await invoke("browser_task_clear_credential");
  } catch (error) {
    logError("browserTask: clear credential", error);
  }
}

/** Human copy for a failure code the row or the card carries. */
export function browserTaskFailureMessage(code: string | null | undefined): string {
  switch (code ?? "") {
    case "browser_not_installed":
      return "No Chrome, Edge or Brave is installed for Buddy to use.";
    case "browser_policy_blocked":
      return "Your organisation blocks browser automation on this machine.";
    case "browser_profile_locked":
      return "Buddy's browser is still open from an earlier task. Close it and try again.";
    case "browser_launch_failed":
      return "Buddy's browser could not start.";
    case "cdp_connect_failed":
    case "cdp_attach_failed":
      return "Buddy could not take control of its browser.";
    case "no_credential":
      return "Buddy is not signed in for browser tasks yet. Try again in a moment.";
    case "browser_agent_paid":
      return "Browser tasks need a paid plan.";
    case "browser_steps_exhausted":
      return "You have used this month's browser task steps.";
    case "browser_agent_project_cap":
      return "Browser tasks are paused for today. Try again tomorrow.";
    case "step_cap":
      return "Buddy reached its step limit and saved what it found.";
    case "time_cap":
      return "Buddy reached its time limit and saved what it found.";
    case "approval_denied":
      return "Buddy stopped because the next step needed a click you did not allow.";
    case "page_closed":
      return "The page Buddy was working on closed.";
    case "app_crash":
      return "Aura closed before this task finished.";
    case "worker_panic":
      return "Something went wrong inside the task.";
    case "blocked:login_required":
      return "The site needed a sign-in, which Buddy never does on its own.";
    case "blocked:captcha":
      return "The site asked for a human check, which Buddy never completes.";
    case "blocked:paywall":
      return "The answer sits behind a paywall.";
    case "blocked:not_found":
      return "Buddy could not find what you asked for.";
    case "blocked:unsafe":
      return "Finishing would have meant buying, sending or submitting something, so Buddy stopped.";
    default:
      return code && code.startsWith("backend_")
        ? "Buddy could not reach its brain. Check your connection and try again."
        : "The task did not finish.";
  }
}
