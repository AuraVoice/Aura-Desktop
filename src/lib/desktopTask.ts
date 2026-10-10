import { invoke } from "@tauri-apps/api/core";
import type { BrowserTaskStatusPayload } from "./ipcEvents";
import type { BrowserTaskSummary } from "./browserTask";

/**
 * Typed client for the desktop Operator (src-tauri/src/agent_operator): a task
 * the user starts from a Swarm desktop_task Start card (swarm/DesktopTaskStart)
 * that runs commands, reads the web, and reads, clicks and types in their own
 * applications. Rust owns the loop, every gate and the encrypted record;
 * this file only names the commands. The backend credential is the browser
 * agent's (the same refresh pump feeds both).
 */

/** Same row shape as a browser task (agent_operator/store.rs TaskSummary). */
export type DesktopTaskSummary = BrowserTaskSummary;

/** Mirrors agent_operator/store.rs TraceEntry. */
export interface DesktopTaskTraceEntry {
  step: number;
  action: string;
  refId: string;
  app: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  costMicrousd: number;
  result: string;
  model: string;
  progressed: boolean;
}

/** Mirrors agent_operator/store.rs TaskDetail. */
export interface DesktopTaskDetail {
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
  trace: DesktopTaskTraceEntry[];
}

/** `origin` is "swarm:<item key>" from a Start card, which is how the card finds the task again. */
export function startDesktopTask(brief: string, origin?: string) {
  return invoke<BrowserTaskStatusPayload>("desktop_task_start", { brief, origin: origin ?? null });
}

export function stopDesktopTask() {
  return invoke<BrowserTaskStatusPayload>("desktop_task_stop");
}

export function approveDesktopTask(allow: boolean) {
  return invoke<void>("desktop_task_approve", { allow });
}

export function desktopTaskStatus() {
  return invoke<BrowserTaskStatusPayload>("desktop_task_status");
}

export function loadDesktopTaskConsent() {
  return invoke<boolean>("desktop_task_consent");
}

export function setDesktopTaskConsent(accepted: boolean) {
  return invoke<boolean>("set_desktop_task_consent", { accepted });
}

export function listDesktopTasks(uid: string) {
  return invoke<DesktopTaskSummary[]>("desktop_tasks_list", { uid });
}

export function loadDesktopTask(uid: string, taskId: string) {
  return invoke<DesktopTaskDetail | null>("desktop_task_load", { uid, taskId });
}

export function deleteDesktopTask(uid: string, taskId: string) {
  return invoke<void>("desktop_task_delete", { uid, taskId });
}

/** Human copy for a failure code a desktop task's row or card carries. */
export function desktopTaskFailureMessage(code: string | null | undefined): string {
  switch (code ?? "") {
    case "no_credential":
      return "Buddy is not signed in for desktop tasks yet. Try again in a moment.";
    case "desktop_agent_paid":
      return "Desktop tasks need a paid plan.";
    case "desktop_steps_exhausted":
      return "You have used this month's desktop task steps.";
    case "desktop_agent_project_cap":
      return "Desktop tasks are paused for today. Try again tomorrow.";
    case "stuck":
      return "Buddy kept hitting the same wall, tried other routes, and stopped with what it had.";
    case "checkin_timeout":
      return "Buddy paused to ask whether to keep going, heard nothing for 30 minutes, and stopped.";
    case "paused_timeout":
      return "Buddy paused when you started using the computer, and nobody resumed it for 30 minutes.";
    case "approval_denied":
      return "Buddy stopped because the next step needed something you did not allow.";
    case "stale_auth":
      return "The account changed or desktop tasks were turned off, so Buddy stopped.";
    case "consent_withdrawn":
      return "Desktop tasks were turned off, so Buddy stopped.";
    case "unsupported_platform":
      return "Desktop tasks work on Windows for now.";
    case "ui_unavailable":
      return "Buddy could not start reading windows on this computer.";
    case "app_crash":
      return "Aura closed before this task finished.";
    case "worker_panic":
      return "Something went wrong inside the task.";
    case "blocked:needs_permission":
      return "The task needs a permission only you can grant.";
    case "blocked:not_found":
      return "Buddy could not find what you asked for.";
    case "blocked:unsafe":
      return "Finishing would have meant something Buddy never does on its own, so it stopped.";
    case "blocked:login_required":
      return "The app needed a sign-in, which Buddy never does on its own.";
    case "blocked:not_possible":
      return "Buddy could not find a way to do this in that app.";
    default:
      return code && code.startsWith("backend_")
        ? "Buddy could not reach its brain. Check your connection and try again."
        : "The task did not finish.";
  }
}
