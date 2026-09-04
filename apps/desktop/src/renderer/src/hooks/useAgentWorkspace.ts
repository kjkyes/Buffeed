import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_AGENT_API,
  eventLabel,
  type Approval,
  type ChatAttachment,
  type ChatMessage,
  type Session,
  type StreamEvent,
} from "../domains/agent";
import { useAgentEventStream } from "../services/agentEvents";
import { useTaskHUD } from "./useTaskHUD";
import {
  cancelTurnRequest,
  checkAgentHealth,
  createSessionRequest,
  createTurnRequest,
  forkSessionRequest,
  getSession,
  getTurnStatusRequest,
  importSessionHistory,
  listModels,
  listSessions,
  resolveApprovalRequest,
  type TurnAttachment,
  type TurnModel,
  type TurnModelOption,
} from "../services/agentApi";

type UseAgentWorkspaceOptions = {
  setStatusMessage: (message: string) => void;
  onTeamEvent?: (event: StreamEvent) => void;
};

export type ComposerAttachment = {
  id: string;
  name: string;
  kind: "file" | "folder" | "image" | "video" | "history";
  path?: string;
  previewUrl?: string;
  context?: string;
  mimeType?: string;
};

type ComposerDraft = {
  prompt: string;
  attachments: ComposerAttachment[];
};

const NEW_CONVERSATION_DRAFT_KEY = "__new_conversation__";
const MAX_PERSISTED_ATTACHMENT_PREVIEW_URL_CHARS = 750_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventOrder(event: StreamEvent): number {
  const numeric = Number(event.event_id);
  const createdAt = event.createdAt ?? Number.POSITIVE_INFINITY;
  return createdAt * 1_000_000 + (Number.isFinite(numeric) ? numeric : 0);
}

const FOLDED_LIFECYCLE_EVENTS = new Set(["model.requested", "turn.completed"]);
// Runtime restoration and first-use model setup can exceed the normal request latency.
const TURN_SUBMIT_TIMEOUT_MS = 20_000;
const ATTACHMENT_CONTEXT_MARKER = "[附件上下文]";

function displayQuery(query: string): string {
  const markerIndex = query.indexOf(`\n\n${ATTACHMENT_CONTEXT_MARKER}`);
  return markerIndex >= 0 ? query.slice(0, markerIndex).trim() : query;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function useAgentWorkspace({
  setStatusMessage,
  onTeamEvent,
}: UseAgentWorkspaceOptions) {
  const [agentApi, setAgentApi] = useState(DEFAULT_AGENT_API);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [model, setModel] = useState<TurnModel>(() => localStorage.getItem("buffeed.model")?.trim() || "system");
  const [modelOptions, setModelOptions] = useState<TurnModelOption[]>([{
    id: "system",
    label: "系统模型",
    provider: "system",
    supports_video: false,
  }]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [agentHealthy, setAgentHealthy] = useState<boolean | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [turnFinishedAt, setTurnFinishedAt] = useState<number | null>(null);
  const [turnSubmitting, setTurnSubmitting] = useState(false);
  const [pendingSteerText, setPendingSteerText] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now() / 1000);
  const [traceExpanded, setTraceExpanded] = useState(true);
  const composerDraftsRef = useRef<Record<string, ComposerDraft>>({});
  const draftKey = activeSessionId ?? NEW_CONVERSATION_DRAFT_KEY;
  const draftKeyRef = useRef(draftKey);
  const sessionSelectionRef = useRef(0);
  const initialSessionIdRef = useRef(new URLSearchParams(window.location.search).get("sessionId"));
  const pendingTurnRef = useRef<{
    clientTurnId: string;
    turnId: string;
    sessionId: string;
    query: string;
    attachments: ChatAttachment[];
  } | null>(null);
  const activeTurnRef = useRef<string | null>(activeTurnId);
  activeTurnRef.current = activeTurnId;

  const restoreAttachmentPreviews = useCallback((turnId: string | null, eventAttachments: ChatAttachment[]) => {
    if (!turnId || !window.desktop?.attachmentThumbnail) return;
    for (const attachment of eventAttachments) {
      if (attachment.previewUrl || (attachment.kind !== "image" && attachment.kind !== "video") || !attachment.path) continue;
      void window.desktop.attachmentThumbnail(attachment.path).then((previewUrl) => {
        if (!previewUrl) return;
        setMessages((current) => current.map((message) => {
          if (message.role !== "user" || message.turnId !== turnId || !message.attachments) return message;
          return {
            ...message,
            attachments: message.attachments.map((item) => (
              item.path === attachment.path && !item.previewUrl ? { ...item, previewUrl } : item
            )),
          };
        }));
      }).catch(() => undefined);
    }
  }, []);

  const saveComposerDraft = useCallback(() => {
    composerDraftsRef.current[draftKey] = {
      prompt,
      attachments: attachments.map((item) => ({ ...item })),
    };
  }, [attachments, draftKey, prompt]);

  useEffect(() => {
    if (draftKeyRef.current !== draftKey) {
      draftKeyRef.current = draftKey;
      return;
    }
    composerDraftsRef.current[draftKey] = {
      prompt,
      attachments: attachments.map((item) => ({ ...item })),
    };
  }, [attachments, draftKey, prompt]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.session_id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const latestTurnEvent = [...events].reverse().find((event) => event.turnId === activeTurnId) ?? null;
  const displayedTurnEnd = activeTurnId ? clockNow : turnFinishedAt;
  const turnElapsedSeconds = turnStartedAt && displayedTurnEnd
    ? Math.max(0, displayedTurnEnd - turnStartedAt)
    : null;
  const turnPhase = activeTurnId
    ? latestTurnEvent
      ? eventLabel(latestTurnEvent.type)
      : "提交任务"
    : null;
  const latestConversationTurnId = activeTurnId ?? [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.turnId)?.turnId ?? null;
  const latestConversationEvents = latestConversationTurnId
    ? events.filter((event) => event.turnId === latestConversationTurnId)
    : [];
  const { taskHUD, taskHUDByTurn, revertChanges, reviewChanges } = useTaskHUD({
    agentApi,
    sessionId: activeSessionId,
    events: latestConversationEvents,
    allEvents: events,
    activeTurnId,
    setStatusMessage,
  });

  const refreshSessions = useCallback(async (baseUrl = agentApi) => {
    const response = await listSessions(baseUrl);
    setSessions(response.sessions);
  }, [agentApi]);

  const refreshAgentHealth = useCallback(async (baseUrl = agentApi) => {
    try {
      await checkAgentHealth(baseUrl);
      setAgentHealthy(true);
    } catch {
      setAgentHealthy(false);
    }
  }, [agentApi]);

  const refreshModels = useCallback(async (baseUrl = agentApi) => {
    const response = await listModels(baseUrl);
    const available = response.models.length > 0 ? response.models : [{
      id: "system",
      label: "系统模型",
      provider: "system",
      supports_video: false,
    }];
    setModelOptions(available);
    setModel((current) => {
      const stored = localStorage.getItem("buffeed.model")?.trim();
      const preferred = stored && available.some((item) => item.id === stored) ? stored : current;
      const next = available.some((item) => item.id === preferred) ? preferred : available[0].id;
      localStorage.setItem("buffeed.model", next);
      return next;
    });
  }, [agentApi]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const localUrl = window.desktop
        ? await window.desktop.apiBaseUrl().catch(() => undefined)
        : undefined;
      const baseUrl = localUrl ?? DEFAULT_AGENT_API;
      if (!mounted) {
        return;
      }
      setAgentApi(baseUrl);
      await Promise.allSettled([
        refreshSessions(baseUrl),
        refreshAgentHealth(baseUrl),
        refreshModels(baseUrl),
      ]);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const initialSessionId = initialSessionIdRef.current;
    if (!initialSessionId || activeSessionId || !sessions.length) {
      return;
    }
    const session = sessions.find((item) => item.session_id === initialSessionId);
    if (session) {
      initialSessionIdRef.current = null;
      void selectSession(session);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (!activeTurnId) {
      return undefined;
    }
    const timer = window.setInterval(() => setClockNow(Date.now() / 1000), 1_000);
    return () => window.clearInterval(timer);
  }, [activeTurnId]);

  useEffect(() => {
    if (activeTurnId || !pendingSteerText) {
      return;
    }
    setPrompt((current) => current || pendingSteerText);
    setPendingSteerText(null);
    setStatusMessage("当前回合已结束，追加消息已放回输入框");
  }, [activeTurnId, pendingSteerText, setStatusMessage]);

  const consumeEvent = useCallback((streamEvent: StreamEvent) => {
    if (FOLDED_LIFECYCLE_EVENTS.has(streamEvent.type)) return;
    setEvents((current) => {
      if (current.some((item) => item.event_id === streamEvent.event_id)) {
        return current;
      }
      const next = [...current, streamEvent].sort(
        (left, right) => eventOrder(left) - eventOrder(right),
      );
      return next;
    });
    onTeamEvent?.(streamEvent);
    if (streamEvent.type === "turn.queued" || streamEvent.type === "turn.started") {
      const isStarted = streamEvent.type === "turn.started";
      const query = String(streamEvent.payload.query ?? "");
      const visibleQuery = displayQuery(query);
      const pending = pendingTurnRef.current;
      const canAdoptPending = Boolean(
        pending
        && pending.sessionId === activeSessionId
        && pending.turnId === streamEvent.turnId
        && pending.query === query,
      );
      const eventAttachments: ChatAttachment[] = Array.isArray(streamEvent.payload.attachments)
        ? streamEvent.payload.attachments.flatMap((item): ChatAttachment[] => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          const name = String(value.name ?? "附件");
          const kind = String(value.kind ?? "file");
          if (!["file", "folder", "image", "video", "audio", "history"].includes(kind)) return [];
          return [{
            name,
            path: typeof value.path === "string" ? value.path : undefined,
            kind: kind as ChatAttachment["kind"],
            mimeType: typeof value.mime_type === "string" ? value.mime_type : undefined,
            previewUrl: typeof value.preview_url === "string" ? value.preview_url : undefined,
          }];
        })
        : [];
      if (isStarted) {
        // Keep the id synchronous so a same-batch turn.finished event can
        // close the turn before React commits the started state update.
        activeTurnRef.current = streamEvent.turnId;
        setTurnStartedAt(streamEvent.createdAt ?? Date.now() / 1000);
        setTurnFinishedAt(null);
        setTraceExpanded(true);
      }
      setMessages((current) => {
        const existing = current.find((message) => message.role === "user" && message.turnId === streamEvent.turnId);
        if (existing) {
          if (eventAttachments.length === 0) return current;
          return current.map((message) => {
            if (message !== existing) return message;
            return {
              ...message,
              attachments: eventAttachments.map((attachment) => {
                const previous = message.attachments?.find((item) => item.path === attachment.path || item.name === attachment.name);
                return { ...attachment, previewUrl: attachment.previewUrl ?? previous?.previewUrl };
              }),
            };
          });
        }
        if (canAdoptPending && pending) {
          return current.map((message) => (
            message.id === pending.clientTurnId
              ? { ...message, id: streamEvent.event_id, turnId: streamEvent.turnId, attachments: pending.attachments }
              : message
          ));
        }
        return [
          ...current,
          {
            id: streamEvent.event_id,
            role: "user",
            text: visibleQuery,
            turnId: streamEvent.turnId,
            attachments: eventAttachments,
          } satisfies ChatMessage,
        ];
      });
      if (isStarted) restoreAttachmentPreviews(streamEvent.turnId, eventAttachments);
      if (canAdoptPending && (streamEvent.type === "turn.queued" || isStarted)) {
        pendingTurnRef.current = null;
        setTurnSubmitting(false);
        if (!isStarted) {
          setStatusMessage("任务已排队，正在准备 Agent 会话");
        }
      }
      if (isStarted) {
        setActiveTurnId(streamEvent.turnId);
      }
    }
    const assistantPhase = String(streamEvent.payload.phase ?? "final");
    if (streamEvent.type === "assistant.message" && assistantPhase === "final") {
      setTraceExpanded(false);
    }
    const streamId = String(streamEvent.payload.stream_id ?? "").trim();
    const streamRetracted = streamEvent.payload.stream_retracted === true;
    if (
      streamEvent.type === "assistant.message"
      && (streamId || !["planning", "finding"].includes(assistantPhase))
    ) {
      const streamDelta = streamEvent.payload.delta !== undefined
        ? String(streamEvent.payload.delta ?? "")
        : String(streamEvent.payload.text ?? "");
      if (streamId) {
        setMessages((current) => {
          if (streamRetracted) {
            return current.filter((message) => message.id !== streamId);
          }
          const existingIndex = current.findIndex(
            (message) => message.id === streamId && message.role === "assistant",
          );
          if (existingIndex < 0) {
            return streamDelta
              ? [
                ...current,
                {
                  id: streamId,
                  role: "assistant",
                  text: streamDelta,
                  turnId: streamEvent.turnId,
                } satisfies ChatMessage,
              ]
              : current;
          }
          if (!streamDelta) {
            return current;
          }
          return current.map((message, index) => (
            index === existingIndex
              ? { ...message, text: `${message.text}${streamDelta}` }
              : message
          ));
        });
      } else {
        setMessages((current) => [
          ...current,
          {
            id: streamEvent.event_id,
            role: "assistant",
            text: streamDelta,
            turnId: streamEvent.turnId,
          } satisfies ChatMessage,
        ]);
      }
    }
    if (streamEvent.type === "approval.requested") {
      setApprovals((current) => [
        ...current,
        {
          id: String(streamEvent.payload.approval_id),
          toolName: String(streamEvent.payload.tool_name),
          input: (streamEvent.payload.input ?? {}) as Record<string, unknown>,
          turnId: streamEvent.turnId,
        },
      ]);
    }
    if (streamEvent.type === "approval.resolved") {
      setApprovals((current) => current.filter((approval) => approval.id !== streamEvent.payload.approval_id));
    }
    if (
      ["turn.finished", "turn.cancelled", "turn.error"].includes(streamEvent.type)
      && streamEvent.turnId === activeTurnRef.current
    ) {
      setApprovals((current) => current.filter((approval) => approval.turnId !== streamEvent.turnId));
      activeTurnRef.current = null;
      setTurnFinishedAt(streamEvent.createdAt ?? Date.now() / 1000);
      setActiveTurnId(null);
      setTurnSubmitting(false);
      setTraceExpanded(false);
      void refreshSessions();
    }
  }, [activeSessionId, activeTurnId, onTeamEvent, refreshSessions]);

  useEffect(() => {
    const currentTurnId = activeTurnRef.current;
    if (!currentTurnId) {
      return;
    }
    const terminalEvent = [...events].reverse().find(
      (event) => event.turnId === currentTurnId
        && ["turn.finished", "turn.cancelled", "turn.error"].includes(event.type),
    );
    if (!terminalEvent) {
      return;
    }
    setApprovals((current) => current.filter((approval) => approval.turnId !== currentTurnId));
    activeTurnRef.current = null;
    setTurnFinishedAt(terminalEvent.createdAt ?? Date.now() / 1000);
    setActiveTurnId(null);
    setTurnSubmitting(false);
    setTraceExpanded(false);
    void refreshSessions();
  }, [events, refreshSessions]);

  const handleEventStreamError = useCallback((error: unknown) => {
    setStatusMessage(error instanceof Error ? error.message : `事件同步失败：${String(error)}`);
  }, [setStatusMessage]);

  useEffect(() => {
    const draft = composerDraftsRef.current[draftKey];
    setMessages([]);
    setEvents([]);
    setApprovals([]);
    activeTurnRef.current = null;
    setActiveTurnId(null);
    setTurnStartedAt(null);
    setTurnFinishedAt(null);
    setTurnSubmitting(false);
    setPendingSteerText(null);
    setClockNow(Date.now() / 1000);
    setTraceExpanded(true);
    pendingTurnRef.current = null;
    setPrompt(draft?.prompt ?? "");
    setAttachments(draft?.attachments.map((item) => ({ ...item })) ?? []);
  }, [activeSessionId, draftKey]);

  const { hasOlderHistory, loadingOlderHistory, loadOlderHistory } = useAgentEventStream({
    baseUrl: agentApi,
    sessionId: activeSessionId,
    fullHistory: activeSession?.history_mode === "full",
    onEvent: consumeEvent,
    onError: handleEventStreamError,
  });

  const createSession = async () => {
    saveComposerDraft();
    const newConversationDraft = activeSessionId === null
      ? composerDraftsRef.current[NEW_CONVERSATION_DRAFT_KEY]
      : undefined;
    const selected = await window.desktop?.selectWorkspace();
    const targetWorkspace = selected?.trim() ?? "";
    if (!targetWorkspace) {
      setStatusMessage("请选择具体项目目录后再创建会话");
      return;
    }
    try {
      const response = await createSessionRequest(agentApi, targetWorkspace);
      if (newConversationDraft) {
        composerDraftsRef.current[response.session_id] = {
          prompt: newConversationDraft.prompt,
          attachments: newConversationDraft.attachments.map((item) => ({ ...item })),
        };
      }
      sessionSelectionRef.current += 1;
      setWorkspace(response.workspace);
      setActiveSessionId(response.session_id);
      setStatusMessage("已创建会话");
      await refreshSessions();
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  };

  const startNewConversation = () => {
    saveComposerDraft();
    sessionSelectionRef.current += 1;
    setActiveSessionId(null);
    setWorkspace("");
    setStatusMessage("请选择项目开始新会话");
  };

  const selectSession = async (session: Session) => {
    if (session.session_id === activeSessionId) {
      return;
    }
    saveComposerDraft();
    const selectionId = ++sessionSelectionRef.current;
    setWorkspace(session.workspace);
    // Switch the renderer immediately; history replay and runtime warming are independent.
    setActiveSessionId(session.session_id);
    setStatusMessage(
      session.history_mode === "full"
        ? "正在加载热点会话完整历史，Agent 会话将在后台恢复"
        : "正在加载近期历史，Agent 会话将在后台恢复",
    );
    try {
      const details = await getSession(agentApi, session.session_id);
      if (sessionSelectionRef.current !== selectionId) {
        return;
      }
      setStatusMessage(
        details.runtime_status === "restoring"
          ? "历史消息加载中，Agent 正在后台恢复"
          : "会话历史已加载",
      );
    } catch (error) {
      if (sessionSelectionRef.current === selectionId) {
        setStatusMessage(`历史加载失败：${errorMessage(error)}`);
      }
    }
  };

  const sendTurn = async () => {
    const supportsVideo = modelOptions.some((item) => item.id === model && item.supports_video);
    const localReadAttachments = attachments.filter(
      (item) => item.kind !== "video" || !supportsVideo,
    );
    const attachmentContext = localReadAttachments.length > 0
      ? `\n\n[附件上下文]\n请使用工作区中的文件解析能力读取以下附件；对于文档提取文字、表格和图表数据，对于图片按需进行视觉分析。\n${localReadAttachments.map((item) => item.context || `${item.kind}: ${item.path || item.name}`).join("\n")}`
      : "";
    const query = `${prompt.trim()}${attachmentContext}`.trim();
    if (!activeSessionId) {
      setStatusMessage("请先选择或创建 Agent 会话");
      return;
    }
    if (!query) {
      setStatusMessage("请输入任务");
      return;
    }
    if (turnSubmitting) {
      setStatusMessage("任务正在提交");
      return;
    }
    if (pendingSteerText) {
      setStatusMessage("请先处理上方的追加消息");
      return;
    }
    if (activeTurnId) {
      setPendingSteerText(query);
      setPrompt("");
      setAttachments([]);
      setStatusMessage("请确认是否将消息追加到当前回合");
      return;
    }
    const requestId = crypto.randomUUID();
    const pendingAttachments = attachments;
    const originalPrompt = prompt.trim();
    const clientTurnId = `client:${requestId}`;
    pendingTurnRef.current = {
      clientTurnId,
      turnId: requestId,
      sessionId: activeSessionId,
      query,
      attachments: pendingAttachments.map((item) => ({
        name: item.name,
        path: item.path,
        kind: item.kind,
        mimeType: item.mimeType,
        previewUrl: item.previewUrl,
      })),
    };
    setMessages((current) => [
      ...current,
      {
        id: clientTurnId,
        role: "user",
        text: originalPrompt,
        turnId: null,
        attachments: pendingAttachments.map((item) => ({
          name: item.name,
          path: item.path,
          kind: item.kind,
          mimeType: item.mimeType,
          previewUrl: item.previewUrl,
        })),
      } satisfies ChatMessage,
    ]);
    setPrompt("");
    setAttachments([]);
    setTurnSubmitting(true);
    setStatusMessage("正在提交任务");
    setTurnStartedAt(null);
    setTurnFinishedAt(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), TURN_SUBMIT_TIMEOUT_MS);
    try {
      const response = await createTurnRequest(
        agentApi,
        activeSessionId,
        query,
        "queue",
        requestId,
        controller.signal,
        pendingAttachments.map((item): TurnAttachment => ({
          path: item.path,
          name: item.name,
          kind: item.kind,
          mime_type: item.mimeType,
          preview_url: item.previewUrl && item.previewUrl.length <= MAX_PERSISTED_ATTACHMENT_PREVIEW_URL_CHARS
            ? item.previewUrl
            : undefined,
          context: item.context,
        })),
        model,
      );
      const pending = pendingTurnRef.current;
      if (pending?.clientTurnId === clientTurnId) {
        setMessages((current) => current.map((message) => (
          message.id === clientTurnId
            ? { ...message, turnId: response.turn_id }
            : message
        )));
        pendingTurnRef.current = null;
      }
      setTurnSubmitting(false);
      if (response.status !== "queued") {
        activeTurnRef.current = response.turn_id;
        setActiveTurnId(response.turn_id);
      }
      if (response.title) {
        setSessions((current) => current.map((session) => (
          session.session_id === activeSessionId
            ? { ...session, title: response.title ?? session.title }
            : session
        )));
      }
      setStatusMessage(response.status === "queued" ? "消息已排队，等待当前回合完成" : "Agent 正在处理请求");
    } catch (error) {
      if (isAbortError(error)) {
        const reconciliationController = new AbortController();
        const reconciliationTimeout = window.setTimeout(
          () => reconciliationController.abort(),
          2_000,
        );
        try {
          const accepted = await getTurnStatusRequest(
            agentApi,
            activeSessionId,
            requestId,
            reconciliationController.signal,
          );
          setMessages((current) => current.map((message) => (
            message.id === clientTurnId
              ? { ...message, turnId: accepted.turn_id }
              : message
          )));
          pendingTurnRef.current = null;
          setTurnSubmitting(false);
          if (accepted.status !== "queued") {
            activeTurnRef.current = accepted.turn_id;
            setActiveTurnId(accepted.turn_id);
          }
          setStatusMessage("任务已提交，正在等待 Agent 会话就绪");
          return;
        } catch {
          // The request may still complete after the browser aborts; remove the
          // optimistic item so a later durable event is the single source of truth.
          setMessages((current) => current.filter((message) => message.id !== clientTurnId));
          setPrompt((current) => current || originalPrompt);
          setAttachments(pendingAttachments);
          setStatusMessage("提交确认超时，请检查 Agent API 后重试");
        } finally {
          window.clearTimeout(reconciliationTimeout);
        }
      } else {
        setAttachments(pendingAttachments);
        setStatusMessage(errorMessage(error));
      }
      if (pendingTurnRef.current?.clientTurnId === clientTurnId) {
        pendingTurnRef.current = null;
      }
      setTurnSubmitting(false);
      setTurnStartedAt(null);
      setTurnFinishedAt(null);
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const addInputFiles = useCallback(async (kind: "file" | "folder") => {
    const selected = await window.desktop?.selectInputPaths(kind, workspace);
    if (!selected?.length) return;
    setAttachments((current) => [...current, ...selected.map((item) => ({ id: crypto.randomUUID(), ...item }))]);
  }, [workspace]);

  const addClipboardImage = useCallback(async () => {
    const image = await window.desktop?.saveClipboardImage(workspace);
    if (!image) return false;
    setAttachments((current) => [...current, { id: crypto.randomUUID(), name: image.name, kind: "image", path: image.path, previewUrl: image.dataUrl, mimeType: image.mimeType }]);
    return true;
  }, [workspace]);

  const addSessionHistory = useCallback(async (sessionId: string) => {
    const imported = await importSessionHistory(agentApi, sessionId);
    if (!imported.text) throw new Error("该会话没有可引入的文本历史");
    setAttachments((current) => [...current, { id: crypto.randomUUID(), name: "会话历史", kind: "history", context: `history (${imported.eventCount} 条消息):\n${imported.text}` }]);
  }, [agentApi]);

  const confirmSteer = async () => {
    const query = pendingSteerText?.trim();
    if (!query || !activeSessionId) {
      return;
    }
    setPendingSteerText(null);
    setTurnSubmitting(true);
    try {
      const response = await createTurnRequest(agentApi, activeSessionId, query, "steer");
      setStatusMessage(
        response.status === "received"
          ? "追加消息已送达，等待主 Agent 读取"
          : response.status === "queued"
            ? "追加消息将在下一条回复处理"
            : "Agent 正在处理追加消息",
      );
    } catch (error) {
      setPrompt(query);
      setStatusMessage(errorMessage(error));
    } finally {
      setTurnSubmitting(false);
    }
  };

  const editSteer = () => {
    if (!pendingSteerText) {
      return;
    }
    setPrompt(pendingSteerText);
    setPendingSteerText(null);
    setStatusMessage("追加消息已放回输入框");
  };

  const cancelSteer = () => {
    if (!pendingSteerText) {
      return;
    }
    setPendingSteerText(null);
    setStatusMessage("已取消追加消息");
  };

  const cancelTurn = async () => {
    if (!activeSessionId || !activeTurnId) {
      return;
    }
    try {
      await cancelTurnRequest(agentApi, activeSessionId, activeTurnId);
      setStatusMessage("已请求协作式停止");
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  };

  const resolveApproval = async (approval: Approval, approved: boolean) => {
    try {
      await resolveApprovalRequest(agentApi, approval.id, approved);
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  };

  const forkTurn = async (turnId: string) => {
    if (!activeSessionId || !turnId) {
      return;
    }
    try {
      const response = await forkSessionRequest(agentApi, activeSessionId, turnId);
      await refreshSessions();
      if (window.desktop?.openSessionWindow) {
        await window.desktop.openSessionWindow(response.session_id);
      } else {
        setStatusMessage("已创建 Fork 会话，请从会话列表打开");
      }
    } catch (error) {
      setStatusMessage(`Fork 会话失败：${errorMessage(error)}`);
    }
  };

  return {
    agentApi,
    sessions,
    activeSessionId,
    activeSession,
    workspace,
    messages,
    approvals,
    prompt,
    attachments,
    model,
    modelOptions,
    setModel: (nextModel: TurnModel) => { localStorage.setItem("buffeed.model", nextModel); setModel(nextModel); },
    addInputFiles,
    addClipboardImage,
    addSessionHistory,
    removeAttachment: (id: string) => setAttachments((current) => current.filter((item) => item.id !== id)),
    activeTurnId,
    turnSubmitting,
    agentHealthy,
    turnElapsedSeconds,
    turnPhase,
    latestConversationTurnId,
    latestConversationEvents,
    conversationEvents: events,
    hasOlderHistory,
    loadingOlderHistory,
    taskHUD,
    taskHUDByTurn,
    traceExpanded,
    setWorkspace,
    setPrompt,
    setTraceExpanded,
    refreshSessions,
    refreshAgentHealth,
    createSession,
    startNewConversation,
    selectSession,
    sendTurn,
    pendingSteerText,
    confirmSteer,
    editSteer,
    cancelSteer,
    cancelTurn,
    revertChanges,
    reviewChanges,
    resolveApproval,
    forkTurn,
    loadOlderHistory,
  };
}
