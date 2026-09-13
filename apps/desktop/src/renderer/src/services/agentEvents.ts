import { useEffect, useRef } from "react";

import {
  STREAM_EVENTS,
  type PersistedStreamEvent,
  type StreamEvent,
} from "../domains/agent";
import type { SseEventData } from "@agentcore/contracts";
import { api } from "./http";

type AgentEventStreamOptions = {
  baseUrl: string;
  sessionId: string | null;
  onEvent: (event: StreamEvent) => void;
  onError?: (error: unknown) => void;
};

type EventHistoryResponse = {
  events: PersistedStreamEvent[];
  latest_event_id?: number | null;
};

const MAX_SEEN_EVENT_KEYS = 4_096;

function fromPersistedEvent(event: PersistedStreamEvent): StreamEvent {
  return {
    event_id: String(event.event_id),
    type: event.event_type,
    turnId: event.turn_id,
    payload: event.payload,
    createdAt: event.created_at,
  };
}

export function useAgentEventStream({
  baseUrl,
  sessionId,
  onEvent,
  onError,
}: AgentEventStreamOptions): void {
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onEventRef.current = onEvent;
    onErrorRef.current = onError;
  }, [onError, onEvent]);

  useEffect(() => {
    let cancelled = false;
    let cursor = 0;
    let initialHistoryLoaded = false;
    let polling = false;
    let source: EventSource | null = null;
    let streamOpened = false;
    let streamConnected = false;
    let reconnectTimer: number | undefined;
    let pollTimer: number | undefined;
    const seenEventKeys = new Set<string>();
    const seenEventOrder: string[] = [];

    const consume = (event: StreamEvent): void => {
      if (cancelled) {
        return;
      }
      const streamId = String(event.payload.stream_id ?? "").trim();
      const streamSeq = Number(event.payload.stream_seq);
      const eventKey = streamId && Number.isFinite(streamSeq)
        ? `stream:${streamId}:${streamSeq}`
        : event.event_id
          ? `event:${event.event_id}`
          : "";
      if (eventKey && seenEventKeys.has(eventKey)) {
        const numericEventId = Number(event.event_id);
        if (Number.isFinite(numericEventId)) {
          cursor = Math.max(cursor, numericEventId);
        }
        return;
      }
      if (!eventKey) {
        return;
      }
      seenEventKeys.add(eventKey);
      seenEventOrder.push(eventKey);
      while (seenEventOrder.length > MAX_SEEN_EVENT_KEYS) {
        const removed = seenEventOrder.shift();
        if (removed) seenEventKeys.delete(removed);
      }
      const numericEventId = Number(event.event_id);
      if (Number.isFinite(numericEventId)) {
        cursor = Math.max(cursor, numericEventId);
      }
      onEventRef.current(event);
    };

    if (!sessionId) {
      return () => {
        cancelled = true;
      };
    }

    const handleStreamEvent = (event: MessageEvent<string>): void => {
      try {
        const data = JSON.parse(event.data) as SseEventData;
        const isVolatile = String(data.payload?.durability ?? "") === "volatile";
        const streamId = String(data.payload?.stream_id ?? "").trim();
        const streamSeq = Number(data.payload?.stream_seq);
        consume({
          event_id: isVolatile && streamId && Number.isFinite(streamSeq)
            ? `volatile:${streamId}:${streamSeq}`
            : isVolatile ? "" : event.lastEventId,
          type: event.type,
          turnId: data.turn_id,
          payload: data.payload,
          createdAt: typeof data.created_at === "number" ? data.created_at : null,
        });
      } catch (error) {
        onErrorRef.current?.(error);
      }
    };

    const openStream = (): void => {
      if (cancelled || streamOpened || !initialHistoryLoaded) {
        return;
      }
      source?.close();
      streamOpened = true;
      streamConnected = false;
      const nextSource = new EventSource(
        `${baseUrl}/api/v1/sessions/${sessionId}/events?after=${cursor}`,
      );
      source = nextSource;
      STREAM_EVENTS.forEach((eventType) => nextSource.addEventListener(eventType, handleStreamEvent));
      nextSource.onopen = () => {
        if (source !== nextSource) return;
        streamConnected = true;
        if (pollTimer !== undefined) {
          window.clearInterval(pollTimer);
          pollTimer = undefined;
        }
      };
      nextSource.onerror = () => {
        if (source !== nextSource) return;
        nextSource.close();
        source = null;
        streamOpened = false;
        streamConnected = false;
        onErrorRef.current?.(new Error("实时事件流已断开，正在按 cursor 重连"));
        if (!cancelled && pollTimer === undefined) {
          pollTimer = window.setInterval(() => void pollEvents(), 750);
        }
        if (!cancelled && reconnectTimer === undefined) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            openStream();
          }, 1_000);
        }
      };
    };

    const pollEvents = async (): Promise<void> => {
      try {
        if (polling || cancelled || (initialHistoryLoaded && streamConnected)) {
          return;
        }
        polling = true;
        const initialQuery = initialHistoryLoaded
          ? `after=${cursor}&stream=false&summary=true`
          : "after=0&stream=false&summary=true&full_history=true";
        const response = await api<EventHistoryResponse>(
          baseUrl,
          `/api/v1/sessions/${sessionId}/events?${initialQuery}`,
        );
        if (cancelled) {
          return;
        }
        response.events.forEach((event) => consume(fromPersistedEvent(event)));
        if (!initialHistoryLoaded) {
          initialHistoryLoaded = true;
          if (typeof response.latest_event_id === "number") {
            cursor = Math.max(cursor, response.latest_event_id);
          }
          openStream();
        }
      } catch (error) {
        if (!cancelled) {
          onErrorRef.current?.(error);
        }
      } finally {
        polling = false;
      }
    };

    const start = async (): Promise<void> => {
      // Load the complete folded history before opening the live stream so the
      // conversation is complete and ordered when the session first appears.
      await pollEvents();
      if (cancelled) {
        return;
      }
      if (pollTimer === undefined && !streamConnected) {
        pollTimer = window.setInterval(() => void pollEvents(), 750);
      }
    };
    void start();

    return () => {
      cancelled = true;
      source?.close();
      source = null;
      streamOpened = false;
      streamConnected = false;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
      }
    };
  }, [baseUrl, sessionId]);
}
