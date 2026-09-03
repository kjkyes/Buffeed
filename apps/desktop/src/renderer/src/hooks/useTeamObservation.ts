import { useCallback, useEffect, useRef, useState } from "react";

import type { StreamEvent } from "../domains/agent";
import { foldTeamEvent, type TeamObservation } from "../domains/team";
import { getTeamObservationEvents } from "../services/agentApi";

type UseTeamObservationOptions = {
  agentApi: string;
  activeSessionId: string | null;
  activeTurnId: string | null;
};

/** Keep the durable Team projection independent from chat and turn state. */
export function useTeamObservation({
  agentApi,
  activeSessionId,
  activeTurnId,
}: UseTeamObservationOptions) {
  const [teamObservation, setTeamObservation] = useState<TeamObservation | null>(null);
  const [teamObservationError, setTeamObservationError] = useState<string | null>(null);
  const currentSessionRef = useRef<string | null>(activeSessionId);
  const currentTurnRef = useRef<string | null>(activeTurnId);
  const executionIdRef = useRef<string | null>(activeTurnId ? `turn:${activeTurnId}` : null);
  const eventCursorRef = useRef(0);
  const pollingRef = useRef(false);
  const observationGenerationRef = useRef(0);

  useEffect(() => {
    currentSessionRef.current = activeSessionId;
    currentTurnRef.current = activeTurnId;
    executionIdRef.current = activeTurnId ? `turn:${activeTurnId}` : null;
    eventCursorRef.current = 0;
    observationGenerationRef.current += 1;
    setTeamObservation(null);
    setTeamObservationError(null);
  }, [activeSessionId, agentApi]);

  useEffect(() => {
    if (!activeTurnId) {
      // Keep the just-finished turn pinned so a late member terminal event
      // cannot replace the current graph with an older execution. The next
      // session switch resets this pin; a new turn below replaces it.
      currentTurnRef.current = null;
      observationGenerationRef.current += 1;
      return;
    }
    if (activeTurnId === currentTurnRef.current) {
      return;
    }
    currentTurnRef.current = activeTurnId;
    executionIdRef.current = `turn:${activeTurnId}`;
    setTeamObservation(null);
    setTeamObservationError(null);
    eventCursorRef.current = 0;
    observationGenerationRef.current += 1;
  }, [activeTurnId]);

  const refreshTeamObservation = useCallback(async (sessionId: string) => {
    if (pollingRef.current) {
      return;
    }
    pollingRef.current = true;
    const requestGeneration = observationGenerationRef.current;
    const requestedExecutionId = executionIdRef.current;
    try {
      const response = await getTeamObservationEvents(
        agentApi,
        sessionId,
        eventCursorRef.current,
        executionIdRef.current,
      );
      if (
        currentSessionRef.current !== sessionId
        || observationGenerationRef.current !== requestGeneration
        || (requestedExecutionId && executionIdRef.current !== requestedExecutionId)
      ) {
        return;
      }
      executionIdRef.current = response.execution_id || executionIdRef.current;
      setTeamObservationError(null);
      const snapshot = response.snapshot;
      const eventIds = response.events
        .map((event) => event.event_id)
        .filter((eventId) => Number.isFinite(eventId));
      eventCursorRef.current = Math.max(
        eventCursorRef.current,
        snapshot.event_cursor ?? 0,
        ...eventIds,
      );
      setTeamObservation((current) => {
        const sameExecution = current?.execution_id === snapshot.execution_id;
        const previousEvents = sameExecution ? current?.events ?? [] : [];
        const mergedEvents = new Map<number, (typeof response.events)[number]>();
        [...previousEvents, ...(snapshot.events ?? []), ...response.events].forEach((event) => {
          if (Number.isFinite(event.event_id)) {
            mergedEvents.set(event.event_id, event);
          }
        });
        const events = [...mergedEvents.values()]
          .sort((left, right) => left.event_id - right.event_id)
          .slice(-100);
        return snapshot.available || snapshot.plan_seen ? { ...snapshot, events } : null;
      });
    } catch (error) {
      if (currentSessionRef.current === sessionId) {
        setTeamObservationError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      pollingRef.current = false;
    }
  }, [agentApi]);

  useEffect(() => {
    if (!activeSessionId) {
      return undefined;
    }
    void refreshTeamObservation(activeSessionId);
    const timer = window.setInterval(() => void refreshTeamObservation(activeSessionId), 1_500);
    return () => window.clearInterval(timer);
  }, [activeSessionId, refreshTeamObservation]);

  const consumeTeamEvent = useCallback((event: StreamEvent) => {
    if (!event.type.startsWith("run.")) {
      return;
    }
    const eventExecutionId = typeof event.payload.execution_id === "string"
      ? event.payload.execution_id
      : "";
    if (!eventExecutionId) {
      return;
    }
    if (executionIdRef.current && executionIdRef.current !== eventExecutionId) {
      const activeExecutionId = currentTurnRef.current ? `turn:${currentTurnRef.current}` : null;
      if (event.type !== "run.plan" || eventExecutionId !== activeExecutionId) {
        return;
      }
      executionIdRef.current = eventExecutionId;
      eventCursorRef.current = 0;
      setTeamObservation(null);
    }
    executionIdRef.current = eventExecutionId;
    const numericCursor = Number(event.event_id);
    if (Number.isFinite(numericCursor) && numericCursor <= eventCursorRef.current) {
      return;
    }
    if (Number.isFinite(numericCursor)) {
      eventCursorRef.current = Math.max(eventCursorRef.current, numericCursor);
    }
    setTeamObservation((current) => foldTeamEvent(current, event));
  }, []);

  return {
    teamObservation,
    teamObservationError,
    consumeTeamEvent,
    refreshTeamObservation,
  };
}
