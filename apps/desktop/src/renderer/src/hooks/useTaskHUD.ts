import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deriveTaskHUD, type TaskHUDState } from "../domains/hud";
import {
  getSessionChanges,
  revertSessionChanges,
  reviewSessionChanges,
  type ChangeFile,
  type ChangeSnapshot,
} from "../services/agentApi";
import type { StreamEvent } from "../domains/agent";

const CHANGE_POLL_INTERVAL_MS = 2_000;

type UseTaskHUDOptions = {
  agentApi: string;
  sessionId: string | null;
  events: StreamEvent[];
  allEvents: StreamEvent[];
  activeTurnId: string | null;
  setStatusMessage: (message: string) => void;
};

type RefreshChanges = (targetTurnId?: string | null) => Promise<void>;

function snapshotFromEvent(event: StreamEvent): ChangeSnapshot | null {
  const value = event.payload.changes;
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = value as Partial<ChangeSnapshot>;
  return Array.isArray(snapshot.files)
    ? snapshot as ChangeSnapshot
    : null;
}

export function useTaskHUD({
  agentApi,
  sessionId,
  events,
  allEvents,
  activeTurnId,
  setStatusMessage,
}: UseTaskHUDOptions): {
  taskHUD: TaskHUDState;
  taskHUDByTurn: Record<string, TaskHUDState>;
  refreshChanges: RefreshChanges;
  revertChanges: () => Promise<void>;
  reviewChanges: () => Promise<void>;
} {
  const [fileChanges, setFileChanges] = useState<ChangeFile[]>([]);
  const [fileChangesByTurn, setFileChangesByTurn] = useState<Record<string, ChangeFile[]>>({});
  const fileChangesRef = useRef<ChangeFile[]>([]);
  const activeTurnRef = useRef<string | null>(null);
  const currentTurnIdRef = useRef<string | null>(activeTurnId);
  const currentSessionIdRef = useRef<string | null>(sessionId);
  const terminalRefreshesRef = useRef(new Set<string>());

  currentTurnIdRef.current = activeTurnId;
  currentSessionIdRef.current = sessionId;

  useEffect(() => {
    fileChangesRef.current = fileChanges;
  }, [fileChanges]);

  useEffect(() => {
    setFileChanges([]);
    fileChangesRef.current = [];
    setFileChangesByTurn({});
    activeTurnRef.current = null;
    terminalRefreshesRef.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (activeTurnId && activeTurnId !== activeTurnRef.current) {
      const previousTurnId = activeTurnRef.current;
      const previousChanges = fileChangesRef.current;
      if (previousTurnId && previousChanges.length > 0) {
        setFileChangesByTurn((current) => ({
          ...current,
          [previousTurnId]: previousChanges,
        }));
      }
      fileChangesRef.current = [];
      setFileChanges([]);
      activeTurnRef.current = activeTurnId;
    }
  }, [activeTurnId]);

  const refreshChanges = useCallback(async (targetTurnId?: string | null) => {
    const requestedSessionId = sessionId;
    const requestedTurnId = targetTurnId === undefined ? activeTurnId : targetTurnId;
    if (!sessionId) {
      setFileChanges([]);
      fileChangesRef.current = [];
      return;
    }
    try {
      const response = await getSessionChanges(agentApi, sessionId);
      if (currentSessionIdRef.current !== requestedSessionId) {
        return;
      }
      const files = response.files;
      if (requestedTurnId && files.length > 0) {
        setFileChangesByTurn((current) => ({ ...current, [requestedTurnId]: files }));
      }
      if (currentTurnIdRef.current === requestedTurnId) {
        fileChangesRef.current = files;
        setFileChanges(files);
      }
    } catch {
      // A missing Git worktree should not interrupt the Agent event stream.
    }
  }, [activeTurnId, agentApi, sessionId]);

  useEffect(() => {
    void refreshChanges();
  }, [refreshChanges]);

  useEffect(() => {
    if (!sessionId || !activeTurnId) {
      return undefined;
    }
    const timer = window.setInterval(() => void refreshChanges(), CHANGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeTurnId, refreshChanges, sessionId]);

  useEffect(() => {
    const latest = events.at(-1);
    if (latest?.type === "tool.result" || latest?.type === "turn.finished" || latest?.type === "turn.error") {
      void refreshChanges();
    }
  }, [events, refreshChanges]);

  useEffect(() => {
    const terminalEvents = allEvents.filter(
      (event) => event.turnId && ["turn.finished", "turn.cancelled", "turn.error"].includes(event.type),
    );
    for (const event of terminalEvents) {
      if (!event.turnId || terminalRefreshesRef.current.has(event.turnId)) {
        continue;
      }
      const snapshot = snapshotFromEvent(event);
      if (snapshot) {
        terminalRefreshesRef.current.add(event.turnId);
        if (snapshot.files.length > 0) {
          setFileChangesByTurn((current) => ({ ...current, [event.turnId!]: snapshot.files }));
        }
        if (currentTurnIdRef.current === event.turnId) {
          fileChangesRef.current = snapshot.files;
          setFileChanges(snapshot.files);
        }
        continue;
      }
      const isLatestTerminal = event === terminalEvents.at(-1);
      if (isLatestTerminal) {
        terminalRefreshesRef.current.add(event.turnId);
        void refreshChanges(event.turnId);
      }
    }
  }, [allEvents, refreshChanges]);

  const taskHUD = useMemo(
    () => deriveTaskHUD(events, fileChanges, Boolean(activeTurnId)),
    [activeTurnId, events, fileChanges],
  );

  const taskHUDByTurn = useMemo(() => {
    const eventsByTurn = new Map<string, StreamEvent[]>();
    for (const event of allEvents) {
      if (!event.turnId) {
        continue;
      }
      const turnEvents = eventsByTurn.get(event.turnId) ?? [];
      turnEvents.push(event);
      eventsByTurn.set(event.turnId, turnEvents);
    }
    const result: Record<string, TaskHUDState> = {};
    for (const [turnId, turnEvents] of eventsByTurn) {
      const changes = fileChangesByTurn[turnId] ?? (turnId === activeTurnId ? fileChanges : []);
      const state = deriveTaskHUD(turnEvents, changes, turnId === activeTurnId);
      if (state.summary) {
        result[turnId] = state;
      }
    }
    return result;
  }, [activeTurnId, allEvents, fileChanges, fileChangesByTurn]);

  const revertChanges = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await revertSessionChanges(agentApi, sessionId);
      fileChangesRef.current = response.changes.files;
      setFileChanges(response.changes.files);
      setFileChangesByTurn({});
      const protectedCount = response.protected_paths.length;
      setStatusMessage(
        protectedCount > 0
          ? `已撤销本会话变更，保留 ${protectedCount} 个原有文件修改`
          : `已撤销 ${response.reverted_paths.length} 个文件的变更`,
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [agentApi, sessionId, setStatusMessage]);

  const reviewChanges = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await reviewSessionChanges(agentApi, sessionId);
      setStatusMessage(`已创建 Code Review 请求 ${response.review_id.slice(0, 8)}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [agentApi, sessionId, setStatusMessage]);

  return { taskHUD, taskHUDByTurn, refreshChanges, revertChanges, reviewChanges };
}
