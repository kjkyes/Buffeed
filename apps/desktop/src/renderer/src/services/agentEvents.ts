import { useCallback, useEffect, useRef, useState } from "react";

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
  fullHistory?: boolean;
  onEvent: (event: StreamEvent) => void;
  onError?: (error: unknown) => void;
};

export type AgentEventHistoryControls = {
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  loadOlderHistory: () => void;
};

type EventHistoryResponse = {
  events: PersistedStreamEvent[];
  has_more_history?: boolean;
  oldest_event_id?: number | null;
  latest_event_id?: number | null;
};

const MAX_SEEN_EVENT_IDS = 2_048;
const HISTORY_WINDOW_EVENTS = 200;

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
  fullHistory = false,
  onEvent,
  onError,
}: AgentEventStreamOptions): AgentEventHistoryControls {
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);
  const loadOlderHistoryRef = useRef<() => void>(() => undefined);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const loadOlderHistory = useCallback(() => loadOlderHistoryRef.current(), []);

  useEffect(() => {
    onEventRef.current = onEvent;
    onErrorRef.current = onError;
  }, [onError, onEvent]);

  useEffect(() => {
    let cancelled = false;
    let cursor = 0;
    let oldestEventId: number | null = null;
    let hasOlder = false;
    let initialHistoryLoaded = false;
    let polling = false;
    let loadingOlder = false;
    let source: EventSource | null = null;
    let streamOpened = false;
    let reconnectTimer: number | undefined;
    let pollTimer: number | undefined;
    const seenEventIds = new Set<string>();
    const seenEventOrder: string[] = [];

    const consume = (event: StreamEvent): void => {
      if (cancelled || !event.event_id || seenEventIds.has(event.event_id)) {
        return;
      }
      seenEventIds.add(event.event_id);
      seenEventOrder.push(event.event_id);
      while (seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
        const expired = seenEventOrder.shift();
        if (expired) {
          seenEventIds.delete(expired);
        }
      }
      const numericEventId = Number(event.event_id);
      if (Number.isFinite(numericEventId)) {
        cursor = Math.max(cursor, numericEventId);
      }
      onEventRef.current(event);
    };

    if (!sessionId) {
      setHasOlderHistory(false);
      setLoadingOlderHistory(false);
      loadOlderHistoryRef.current = () => undefined;
      return () => {
        cancelled = true;
      };
    }

    const handleStreamEvent = (event: MessageEvent<string>): void => {
      try {
        const data = JSON.parse(event.data) as SseEventData;
        consume({
          event_id: event.lastEventId,
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
      source = new EventSource(
        `${baseUrl}/api/v1/sessions/${sessionId}/events?after=${cursor}`,
      );
      STREAM_EVENTS.forEach((eventType) => source?.addEventListener(eventType, handleStreamEvent));
      source.onerror = () => {
        source?.close();
        source = null;
        streamOpened = false;
        onErrorRef.current?.(new Error("实时事件流已断开，正在按 cursor 重连"));
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
        if (polling || cancelled) {
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
          oldestEventId = typeof response.oldest_event_id === "number"
            ? response.oldest_event_id
            : null;
          hasOlder = false;
          setHasOlderHistory(hasOlder);
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

    const loadOlder = async (): Promise<void> => {
      if (cancelled || loadingOlder || !initialHistoryLoaded || !hasOlder || oldestEventId === null) {
        return;
      }
      loadingOlder = true;
      setLoadingOlderHistory(true);
      try {
        const response = await api<EventHistoryResponse>(
          baseUrl,
          `/api/v1/sessions/${sessionId}/events?stream=false&summary=true&before=${oldestEventId}&limit=${HISTORY_WINDOW_EVENTS}`,
        );
        if (cancelled) {
          return;
        }
        response.events.forEach((event) => consume(fromPersistedEvent(event)));
        if (typeof response.oldest_event_id === "number") {
          oldestEventId = response.oldest_event_id;
        }
        hasOlder = response.has_more_history === true;
        setHasOlderHistory(hasOlder);
      } catch (error) {
        if (!cancelled) {
          onErrorRef.current?.(error);
        }
      } finally {
        loadingOlder = false;
        if (!cancelled) {
          setLoadingOlderHistory(false);
        }
      }
    };
    loadOlderHistoryRef.current = () => void loadOlder();

    const start = async (): Promise<void> => {
      // Load the complete folded history before opening the live stream so the
      // conversation is complete and ordered when the session first appears.
      await pollEvents();
      if (cancelled) {
        return;
      }
      pollTimer = window.setInterval(() => void pollEvents(), 750);
    };
    void start();

    return () => {
      cancelled = true;
      source?.close();
      source = null;
      streamOpened = false;
      loadOlderHistoryRef.current = () => undefined;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
      }
    };
  }, [baseUrl, sessionId, fullHistory]);

  return { hasOlderHistory, loadingOlderHistory, loadOlderHistory };
}
