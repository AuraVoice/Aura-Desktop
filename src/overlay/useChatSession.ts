import { useCallback, useEffect, useRef, useState } from "react";
import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { validateAgentDataMessage } from "../lib/agentData";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { setChatConversationId, setTextHandoffProvider } from "../lib/chatConversation";
import {
  ChatRequestError,
  streamChat,
  type ChatDoneMetadata,
  type ChatHistoryEntry,
  type ChatStreamFrame,
} from "../lib/chatStream";
import type { ChatAttachment } from "../lib/chatScreenCapture";
import { logError } from "../lib/log";
import { MAX_MESSAGE_LENGTH, type ChatLane, type ChatMessage } from "./ChatSlot";

interface UseChatSessionOptions {
  enabled: boolean;
  room: Room | null;
  /** Screen context for the turn about to go out, resolved at send time so the
   * frame is as fresh as the message. Cold lane only - see the live-lane note
   * in runTurn. Must never throw; a message goes out without its picture
   * rather than not at all. */
  resolveAttachments?: () => Promise<ChatAttachment[]>;
}

function historyFrom(messages: ChatMessage[], excludedTurnId?: string): ChatHistoryEntry[] {
  return messages
    .filter((message) => message.turnId !== excludedTurnId)
    .flatMap<ChatHistoryEntry>((message) => {
      if (
        message.role === "user"
        && message.lane !== "live"
        && (message.state === "sent" || message.state === "complete")
        && (!message.kind || message.kind === "text")
      ) {
        return [{ role: "user", content: message.text }];
      }
      if (
        message.role === "assistant"
        && message.lane !== "live"
        && message.state === "complete"
        && message.text
        && (!message.kind || message.kind === "text" || message.kind === "clarification")
      ) {
        return [{ role: "assistant", content: message.text }];
      }
      return [];
    })
    .slice(-100);
}

/** What the transcript says when a turn fails without an `error` frame. Only a
 * genuine transport failure gets blamed on the connection; a rejected request
 * names its own status so Retry is not offered as the answer to everything. */
function failureText(err: unknown): string {
  if (err instanceof LiveTurnFailure) {
    if (err.reason === "no_response") {
      return "Aura stopped responding to this message. Retry to send it again.";
    }
    if (err.reason === "duplicate") return "Aura already received this message and did not run it twice.";
    if (err.reason === "busy" || err.reason === "busy_timeout") {
      return "Aura was still finishing another turn. Retry this message in a moment.";
    }
    if (err.reason === "message_too_long") return "This message is longer than the live chat limit.";
    return "Aura could not finish this live message. Retry to try again.";
  }
  if (!(err instanceof ChatRequestError)) {
    return "The connection dropped before Aura finished. Retry this message to continue.";
  }
  if (err.status === 429) {
    return "Aura is handling too many requests right now. Retry this message in a moment.";
  }
  if (err.status >= 500) {
    return `Aura's server could not answer this message (HTTP ${err.status}). Retry to try again.`;
  }
  return `Aura could not accept this message (HTTP ${err.status}).`;
}

class LiveTurnFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// A live turn is watched only while the worker owes an event on a bounded
// timeline: from publish until the accept ack, and from the start ack until the
// turn ends. The gap between those two is real queue wait behind other turns,
// which has no bound and is already honestly shown as "Queued, N ahead", so
// watching it would fail turns that are merely waiting their proper turn.
const LIVE_ACK_TIMEOUT_MS = 10_000;
const LIVE_PROGRESS_TIMEOUT_MS = 60_000;

function reminderText(reminder: Record<string, unknown>): string {
  const message = typeof reminder.message === "string" ? reminder.message : "Reminder updated";
  const triggerAt = typeof reminder.trigger_at === "string" ? reminder.trigger_at : "";
  return triggerAt ? `${message}\n${triggerAt}` : message;
}

export function useChatSession({ enabled, room, resolveAttachments }: UseChatSessionOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const lane: ChatLane = enabled && room ? "live" : "cold";
  const conversationIdRef = useRef(crypto.randomUUID());
  const enabledRef = useRef(enabled);
  const roomRef = useRef(room);
  const liveGenerationRef = useRef(0);
  const livePendingRef = useRef(new Set<string>());
  const liveWatchdogsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const activeRequestRef = useRef<{ clientMessageId: string; controller: AbortController } | null>(null);
  const messagesRef = useRef(messages);
  const resolveAttachmentsRef = useRef(resolveAttachments);
  roomRef.current = enabled ? room : null;
  messagesRef.current = messages;
  resolveAttachmentsRef.current = resolveAttachments;

  const upsertMessage = useCallback((message: ChatMessage) => {
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index < 0) return [...current, message];
      return current.map((item, itemIndex) => itemIndex === index ? message : item);
    });
  }, []);

  const clearLiveWatchdog = useCallback((clientMessageId: string) => {
    const timer = liveWatchdogsRef.current.get(clientMessageId);
    if (timer === undefined) return;
    clearTimeout(timer);
    liveWatchdogsRef.current.delete(clientMessageId);
  }, []);

  const failLiveTurn = useCallback((clientMessageId: string, err: unknown) => {
    clearLiveWatchdog(clientMessageId);
    livePendingRef.current.delete(clientMessageId);
    setMessages((current) => {
      const updated = current.flatMap<ChatMessage>((message) => {
        if (message.id === clientMessageId) return [{ ...message, state: "failed" }];
        if (message.id !== `${clientMessageId}:assistant`) return [message];
        return message.text ? [{ ...message, state: "complete" }] : [];
      }).filter((message) => message.id !== `${clientMessageId}:error`);
      return [
        ...updated,
        {
          id: `${clientMessageId}:error`,
          turnId: clientMessageId,
          role: "assistant",
          text: failureText(err),
          state: "complete",
          kind: "error",
          lane: "live",
        },
      ];
    });
  }, [clearLiveWatchdog]);

  /** Fails the turn locally if the worker goes silent while it owes an event. */
  const armLiveWatchdog = useCallback((clientMessageId: string, timeoutMs: number) => {
    clearLiveWatchdog(clientMessageId);
    liveWatchdogsRef.current.set(clientMessageId, setTimeout(() => {
      liveWatchdogsRef.current.delete(clientMessageId);
      if (!livePendingRef.current.has(clientMessageId)) return;
      failLiveTurn(clientMessageId, new LiveTurnFailure("no_response"));
    }, timeoutMs));
  }, [clearLiveWatchdog, failLiveTurn]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) {
      // Published for the voice start path, which sends it as
      // /voice/token?conversation_id= and hands the recent text turns over with
      // it. The same id lives for the whole signed-in chat session, so a voice
      // call started mid-conversation continues that conversation rather than
      // opening a new one; it resets only in the sign-out branch below.
      setChatConversationId(conversationIdRef.current);
      // Read once at voice start, so a streaming reply does not rebuild the
      // digest on every delta.
      setTextHandoffProvider(() => historyFrom(messagesRef.current));
      return () => setTextHandoffProvider(null);
    }
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
    for (const timer of liveWatchdogsRef.current.values()) clearTimeout(timer);
    liveWatchdogsRef.current.clear();
    livePendingRef.current.clear();
    conversationIdRef.current = crypto.randomUUID();
    setChatConversationId(null);
    setTextHandoffProvider(null);
    setMessages([]);
    setSending(false);
    setLimitReached(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !room) return;
    liveGenerationRef.current += 1;

    function onDataReceived(
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) {
      try {
        const verdict = validateAgentDataMessage(payload, participant, topic);
        if (verdict.kind !== "valid" || topic !== "agent_events") return;
        if (
          verdict.type !== "assistant.text.delta"
          && verdict.type !== "assistant.text.done"
          && verdict.type !== "text_input.accepted"
          && verdict.type !== "text_input.started"
          && verdict.type !== "text_input.failed"
        ) return;
        const clientMessageId = verdict.payload.client_message_id as string;
        if (!livePendingRef.current.has(clientMessageId)) return;

        if (verdict.type === "text_input.accepted") {
          // Acked. What follows is queue wait with no bound, so stop watching
          // until the worker actually starts this turn.
          clearLiveWatchdog(clientMessageId);
          const queuePosition = verdict.payload.queue_position as number;
          setMessages((current) => current.map((message) =>
            message.id === clientMessageId
              ? { ...message, state: "queued", queuePosition }
              : message,
          ));
          return;
        }
        if (verdict.type === "text_input.started") {
          armLiveWatchdog(clientMessageId, LIVE_PROGRESS_TIMEOUT_MS);
          setMessages((current) => {
            const assistantId = `${clientMessageId}:assistant`;
            const started = current.map((message) =>
              message.id === clientMessageId
                ? { ...message, state: "sent" as const, queuePosition: undefined }
                : message,
            );
            if (started.some((message) => message.id === assistantId)) return started;
            return [
              ...started,
              {
                id: assistantId,
                turnId: clientMessageId,
                role: "assistant",
                text: "",
                state: "streaming",
                kind: "text",
                lane: "live",
              },
            ];
          });
          return;
        }
        if (verdict.type === "assistant.text.delta") {
          armLiveWatchdog(clientMessageId, LIVE_PROGRESS_TIMEOUT_MS);
          const delta = verdict.payload.text as string;
          setMessages((current) => {
            const assistantId = `${clientMessageId}:assistant`;
            if (current.some((message) => message.id === assistantId)) {
              return current.map((message) =>
                message.id === assistantId
                  ? { ...message, text: message.text + delta, state: "streaming" }
                  : message,
              );
            }
            return [
              ...current,
              {
                id: assistantId,
                turnId: clientMessageId,
                role: "assistant",
                text: delta,
                state: "streaming",
                kind: "text",
                lane: "live",
              },
            ];
          });
          return;
        }
        if (verdict.type === "assistant.text.done") {
          const finalText = verdict.payload.text as string;
          clearLiveWatchdog(clientMessageId);
          livePendingRef.current.delete(clientMessageId);
          setMessages((current) => {
            const assistantId = `${clientMessageId}:assistant`;
            const completed = current.map((message) => {
              if (message.id === clientMessageId) {
                return { ...message, state: "complete" as const, queuePosition: undefined };
              }
              if (message.id === assistantId) {
                return { ...message, text: finalText || message.text, state: "complete" as const };
              }
              return message;
            });
            if (!finalText || completed.some((message) => message.id === assistantId)) return completed;
            return [
              ...completed,
              {
                id: assistantId,
                turnId: clientMessageId,
                role: "assistant",
                text: finalText,
                state: "complete",
                kind: "text",
                lane: "live",
              },
            ];
          });
          return;
        }
        failLiveTurn(clientMessageId, new LiveTurnFailure(verdict.payload.reason as string));
      } catch (err) {
        logError("useChatSession: live event", err);
      }
    }

    function failPendingConnection() {
      for (const clientMessageId of Array.from(livePendingRef.current)) {
        failLiveTurn(clientMessageId, new Error("LiveKit room disconnected"));
      }
    }

    room.on(RoomEvent.DataReceived, onDataReceived);
    room.on(RoomEvent.Disconnected, failPendingConnection);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
      room.off(RoomEvent.Disconnected, failPendingConnection);
      failPendingConnection();
    };
  }, [armLiveWatchdog, clearLiveWatchdog, enabled, failLiveTurn, room]);

  const runTurn = useCallback(async (
    clientMessageId: string,
    text: string,
    history: ChatHistoryEntry[],
    // False for a retry: the frame that went with the original attempt is gone
    // (screen context is one-shot), and quietly attaching a picture of a
    // different moment would make Retry send a different message than the one
    // that failed.
    withScreenContext = false,
  ) => {
    if (!enabledRef.current || activeRequestRef.current) return;
    const controller = new AbortController();
    activeRequestRef.current = { clientMessageId, controller };
    setSending(true);

    const assistantId = `${clientMessageId}:assistant`;
    let terminalFrameSeen = false;
    let errorFrameSeen = false;

    setMessages((current) => [
      ...current.filter((message) => message.turnId !== clientMessageId || message.role === "user"),
      {
        id: assistantId,
        turnId: clientMessageId,
        role: "assistant",
        text: "",
        state: "streaming",
        kind: "text",
      },
    ]);

    const upsert = (message: ChatMessage) => {
      setMessages((current) => {
        const index = current.findIndex((item) => item.id === message.id);
        if (index < 0) return [...current, message];
        return current.map((item, itemIndex) => itemIndex === index ? message : item);
      });
    };

    // The tool progress line is transient: it says what Aura is doing right now,
    // so it has to go once the turn is over, or it sits below the finished
    // answer forever (it is appended after the assistant bubble).
    const toolStatusId = `${clientMessageId}:tool-status`;

    const finishAssistantText = () => {
      setMessages((current) => current.flatMap((message) => {
        if (message.id === toolStatusId) return [];
        if (message.id !== assistantId) return [message];
        return message.text ? [{ ...message, state: "complete" as const }] : [];
      }));
    };

    const markUser = (state: "sent" | "failed") => {
      setMessages((current) => current.map((message) =>
        message.id === clientMessageId ? { ...message, state } : message,
      ));
    };

    const handleDone = (metadata: ChatDoneMetadata) => {
      terminalFrameSeen = true;
      finishAssistantText();
      markUser("sent");
      if (metadata.reminder) {
        upsert({
          id: `${clientMessageId}:reminder`,
          turnId: clientMessageId,
          role: "assistant",
          text: reminderText(metadata.reminder),
          state: "complete",
          kind: "reminder",
        });
      }
    };

    const handleFrame = (frame: ChatStreamFrame) => {
      switch (frame.type) {
        case "text_delta":
          setMessages((current) => current.map((message) =>
            message.id === assistantId ? { ...message, text: message.text + frame.delta } : message,
          ));
          break;
        case "tool_thinking":
        case "tool_status":
          upsert({
            id: toolStatusId,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.message,
            state: "complete",
            kind: "status",
          });
          break;
        case "clarification_ui":
          upsert({
            id: `${clientMessageId}:clarification:${frame.clarification_id}`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.question,
            state: "complete",
            kind: "clarification",
            clarificationId: frame.clarification_id,
            options: frame.options,
            multiSelect: frame.multi_select,
          });
          break;
        case "chat_limit_reached":
          terminalFrameSeen = true;
          finishAssistantText();
          markUser("sent");
          setLimitReached(true);
          upsert({
            id: `${clientMessageId}:limit`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.message,
            state: "complete",
            kind: "limit",
          });
          break;
        case "error":
          terminalFrameSeen = true;
          errorFrameSeen = true;
          finishAssistantText();
          markUser("failed");
          upsert({
            id: `${clientMessageId}:error`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.message,
            state: "complete",
            kind: "error",
          });
          break;
        case "done":
          handleDone(frame.metadata);
          break;
        case "degraded":
          upsert({
            id: `${clientMessageId}:degraded:${crypto.randomUUID()}`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.message,
            state: "complete",
            kind: "degraded",
          });
          break;
        case "terminator":
          break;
      }
    };

    const attachments = withScreenContext && resolveAttachmentsRef.current
      ? await resolveAttachmentsRef.current()
      : [];

    try {
      await streamChat({
        message: text,
        history,
        sessionId: conversationIdRef.current,
        clientMessageId,
        attachments,
        signal: controller.signal,
        onOpen: () => markUser("sent"),
        onFrame: handleFrame,
      });
      if (!terminalFrameSeen) {
        throw new Error("Chat stream reached [DONE] without a terminal frame");
      }
    } catch (err) {
      if (controller.signal.aborted && !enabledRef.current) return;
      if (!errorFrameSeen) {
        markUser("failed");
        finishAssistantText();
        upsert({
          id: `${clientMessageId}:error`,
          turnId: clientMessageId,
          role: "assistant",
          text: failureText(err),
          state: "complete",
          kind: "error",
        });
      }
      if (err instanceof AuthRequiredError) {
        await routeToDashboardForExpiredSession();
      } else {
        logError("useChatSession: stream", err);
      }
    } finally {
      if (activeRequestRef.current?.clientMessageId === clientMessageId) {
        activeRequestRef.current = null;
        setSending(false);
      }
    }
  }, []);

  const publishLiveTurn = useCallback((clientMessageId: string, text: string) => {
    const targetRoom = roomRef.current;
    if (!enabledRef.current || !targetRoom) return false;
    livePendingRef.current.add(clientMessageId);
    armLiveWatchdog(clientMessageId, LIVE_ACK_TIMEOUT_MS);
    const payload = new TextEncoder().encode(JSON.stringify({
      type: "text_input",
      text,
      client_message_id: clientMessageId,
      generation: liveGenerationRef.current,
    }));
    void targetRoom.localParticipant.publishData(payload, {
      reliable: true,
      topic: "client_events",
    }).catch((err) => {
      if (!livePendingRef.current.has(clientMessageId)) return;
      failLiveTurn(clientMessageId, err);
      logError("useChatSession: live publish", err);
    });
    return true;
  }, [armLiveWatchdog, failLiveTurn]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    const currentLane: ChatLane = roomRef.current ? "live" : "cold";
    if (
      !enabledRef.current
      || (currentLane === "cold" && (activeRequestRef.current || sending || limitReached))
      || !trimmed
      || trimmed.length > MAX_MESSAGE_LENGTH[currentLane]
    ) return false;
    const clientMessageId = crypto.randomUUID();
    const history = currentLane === "cold" ? historyFrom(messages) : [];
    setMessages((current) => [
      ...current,
      {
        id: clientMessageId,
        turnId: clientMessageId,
        role: "user",
        text: trimmed,
        state: "queued",
        kind: "text",
        lane: currentLane,
      },
    ]);
    if (currentLane === "live") return publishLiveTurn(clientMessageId, trimmed);
    void runTurn(clientMessageId, trimmed, history, true);
    return true;
  }, [limitReached, messages, publishLiveTurn, runTurn, sending]);

  const retry = useCallback((clientMessageId: string) => {
    const message = messages.find((item) => item.id === clientMessageId && item.role === "user");
    if (!message) return;
    if (message.lane === "live") {
      if (!enabledRef.current || !roomRef.current || livePendingRef.current.has(clientMessageId)) return;
      // The worker rejects any client_message_id it has already enqueued, which
      // is what stops an accidental double-publish from running twice. A retry
      // the user asked for is a new turn, so it needs a fresh id or it comes
      // straight back as "duplicate" and can never succeed. The bubble is
      // re-keyed to that id so every derived event id still correlates.
      const retryMessageId = crypto.randomUUID();
      setMessages((current) => current
        .filter((item) => item.turnId !== clientMessageId || item.role === "user")
        .map((item) => item.id === clientMessageId
          ? { ...item, id: retryMessageId, turnId: retryMessageId, state: "queued", queuePosition: undefined }
          : item));
      publishLiveTurn(retryMessageId, message.text);
      return;
    }
    if (!enabledRef.current || activeRequestRef.current || sending || limitReached) return;
    const history = historyFrom(messages, clientMessageId);
    setMessages((current) => current
      .filter((item) => item.turnId !== clientMessageId || item.role === "user")
      .map((item) => item.id === clientMessageId ? { ...item, state: "queued" } : item));
    void runTurn(clientMessageId, message.text, history);
  }, [limitReached, messages, publishLiveTurn, runTurn, sending]);

  const submitClarification = useCallback((messageId: string, selectedOptions: string[]) => {
    if (activeRequestRef.current || sending || limitReached || selectedOptions.length === 0) return;
    const reply = selectedOptions.join(", ");
    const currentLane: ChatLane = roomRef.current ? "live" : "cold";
    if (reply.length > MAX_MESSAGE_LENGTH[currentLane]) {
      upsertMessage({
        id: `${messageId}:length-error`,
        role: "assistant",
        text: `This clarification reply is longer than the ${MAX_MESSAGE_LENGTH[currentLane].toLocaleString()} character limit.`,
        state: "complete",
        kind: "error",
        lane: currentLane,
      });
      return;
    }
    setMessages((current) => current.map((message) =>
      message.id === messageId ? { ...message, selectedOptions } : message,
    ));
    send(reply);
  }, [limitReached, send, sending, upsertMessage]);

  const noteVoiceSessionStarted = useCallback(() => {
    setMessages((current) => {
      if (current.length === 0 || current[current.length - 1]?.kind === "divider") return current;
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: "Voice session started. Aura does not carry the text above into this call yet.",
          state: "complete",
          kind: "divider",
        },
      ];
    });
  }, []);

  return {
    messages,
    sending: lane === "cold" && sending,
    limitReached: lane === "cold" && limitReached,
    lane,
    send,
    retry,
    submitClarification,
    noteVoiceSessionStarted,
  };
}
