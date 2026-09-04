import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import OpenCC from "opencc-js/t2cn";

import {
  ArrowDown,
  ChevronsUpDown,
  ChevronDown,
  Database,
  FolderOpen,
  GitFork,
  LoaderCircle,
  Pencil,
  SendHorizontal,
  Plus,
  Mic,
  MicOff,
  Square,
  X,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";

import type { ChatAttachment, ChatMessage, Session, StreamEvent } from "../domains/agent";
import { deriveTaskHUD, type TaskHUDState } from "../domains/hud";
import { durationLabel, turnTimeLabel } from "../utils/format";
import { CopyButton } from "./CopyButton";
import { ExecutionTrace } from "./ExecutionTrace";
import { MarkdownContent } from "./MarkdownContent";
import { TaskHUD } from "./TaskHUD";
import { ApprovalPanel } from "./ApprovalPanel";
import type { Approval } from "../domains/agent";
import type { ComposerAttachment } from "../hooks/useAgentWorkspace";
import type { TurnModel, TurnModelOption } from "../services/agentApi";
import logoUrl from "../assets/buffeed-logo.png";

type AgentWorkspaceProps = {
  theme: "light" | "dark";
  agentApi: string;
  activeSession: Session | null;
  sessions: Session[];
  activeSessionId: string | null;
  approvals: Approval[];
  messages: ChatMessage[];
  latestConversationTurnId: string | null;
  latestConversationEvents: StreamEvent[];
  conversationEvents: StreamEvent[];
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  taskHUD: TaskHUDState;
  taskHUDByTurn: Record<string, TaskHUDState>;
  activeTurnId: string | null;
  turnSubmitting: boolean;
  pendingSteerText: string | null;
  turnElapsedSeconds: number | null;
  turnPhase: string | null;
  traceExpanded: boolean;
  prompt: string;
  model: TurnModel;
  modelOptions: TurnModelOption[];
  onModelChange: (model: TurnModel) => void;
  onToggleTrace: () => void;
  onLoadOlderHistory: () => void;
  onPromptChange: (prompt: string) => void;
  onCreateSession: () => void | Promise<void>;
  attachments: ComposerAttachment[];
  onAddInputFiles: (kind: "file" | "folder") => void | Promise<void>;
  onAddClipboardImage: () => void | Promise<boolean>;
  onAddSessionHistory: (sessionId: string) => void | Promise<void>;
  onRemoveAttachment: (id: string) => void;
  onOpenAttachment: (path: string) => void;
  onSendTurn: () => void | Promise<void>;
  onConfirmSteer: () => void | Promise<void>;
  onEditSteer: () => void;
  onCancelSteer: () => void;
  onCancelTurn: () => void | Promise<void>;
  onRevertChanges: () => void | Promise<void>;
  onReviewChanges: (turnId?: string, path?: string) => void | Promise<void>;
  onResolveApproval: (approval: Approval, approved: boolean) => void | Promise<void>;
  onForkTurn: (turnId: string) => void | Promise<void>;
  toolPanelVisible: boolean;
  onToggleToolPanel: () => void;
};

const COMPOSER_MIN_HEIGHT = 48;
const COMPOSER_AUTO_MAX_HEIGHT = 128;
const COMPOSER_HEIGHT_STORAGE_KEY = "buffeed.composer-height";
const MESSAGE_BOTTOM_THRESHOLD = 24;

type ComposerResizeState = {
  pointerId: number;
  startY: number;
  startHeight: number;
};

type ConversationMessageGroup = {
  key: string;
  turnId: string | null;
  messages: ChatMessage[];
};

type VoiceRecorderState = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
};

const traditionalToSimplified = OpenCC.Converter({ from: "t", to: "cn" });

function encodeWav(audioBuffer: AudioBuffer, targetSampleRate = 16_000): ArrayBuffer {
  const sourceChannels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index));
  const sourceLength = sourceChannels[0]?.length ?? 0;
  const sampleRateRatio = audioBuffer.sampleRate / targetSampleRate;
  const sampleCount = Math.max(1, Math.round(sourceLength / sampleRateRatio));
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const sourcePosition = index * sampleRateRatio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, Math.max(0, sourceLength - 1));
    const interpolation = sourcePosition - leftIndex;
    let value = 0;
    for (const channel of sourceChannels) {
      const left = channel[leftIndex] ?? 0;
      const right = channel[rightIndex] ?? left;
      value += left + (right - left) * interpolation;
    }
    value /= Math.max(1, sourceChannels.length);
    value = Math.max(-1, Math.min(1, value));
    samples[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  const output = new ArrayBuffer(44 + samples.byteLength);
  const view = new DataView(output);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.byteLength, true);
  new Int16Array(output, 44).set(samples);
  return output;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function formatVoiceError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message)
      : String(error ?? "未知错误");
  const remoteMatch = raw.match(/Error invoking remote method[^:]*:\s*Error:\s*([\s\S]*)$/i);
  const detail = (remoteMatch?.[1] ?? raw)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return detail || "未知错误";
}

function UserMessage({
  text,
  highlighted,
  attachments,
  onPreviewAttachment,
}: {
  text: string;
  highlighted: boolean;
  attachments?: ChatAttachment[];
  onPreviewAttachment: (attachment: { name: string; kind: "image" | "video"; path?: string; previewUrl: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 420 || text.split(/\r?\n/).length > 8;
  const visualAttachments = (attachments ?? []).filter((item) => (
    (item.kind === "image" || item.kind === "video") && item.previewUrl
  ));
  return (
    <article className={`message user ${highlighted ? "message-highlighted" : ""}`}>
      {visualAttachments.length > 0 && (
        <div className="message-attachments" aria-label="本回合媒体附件">
          {visualAttachments.map((item) => (
            <button
              className="message-attachment-preview"
              type="button"
              key={`${item.path ?? item.name}-${item.previewUrl}`}
              title="放大预览"
              onClick={() => onPreviewAttachment({ name: item.name, kind: item.kind as "image" | "video", path: item.path, previewUrl: item.previewUrl! })}
            >
              <img src={item.previewUrl} alt={item.name} />
              {item.kind === "video" && <span className="message-attachment-video-badge">视频</span>}
            </button>
          ))}
        </div>
      )}
      <div className={`message-content ${isLong && !expanded ? "user-message-collapsed" : ""}`}>
        <MarkdownContent text={text} />
      </div>
      <div className="message-copy-row message-copy-row-user">
        <CopyButton text={text} label="复制提问" className="message-copy-button" />
      </div>
      {isLong && (
        <button
          className="message-collapse-toggle"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开完整提问"}
        </button>
      )}
    </article>
  );
}

export function AgentWorkspace({
  theme,
  agentApi,
  activeSession,
  sessions,
  activeSessionId,
  approvals,
  messages,
  latestConversationTurnId,
  latestConversationEvents,
  conversationEvents,
  hasOlderHistory,
  loadingOlderHistory,
  taskHUD,
  taskHUDByTurn,
  activeTurnId,
  turnSubmitting,
  pendingSteerText,
  turnElapsedSeconds,
  turnPhase,
  traceExpanded,
  prompt,
  model,
  modelOptions,
  onModelChange,
  onToggleTrace,
  onLoadOlderHistory,
  onPromptChange,
  onCreateSession,
  attachments,
  onAddInputFiles,
  onAddClipboardImage,
  onAddSessionHistory,
  onRemoveAttachment,
  onOpenAttachment,
  onSendTurn,
  onConfirmSteer,
  onEditSteer,
  onCancelSteer,
  onCancelTurn,
  onRevertChanges,
  onReviewChanges,
  onResolveApproval,
  onForkTurn,
  toolPanelVisible,
  onToggleToolPanel,
}: AgentWorkspaceProps) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentTriggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerContainerRef = useRef<HTMLElement>(null);
  const turnRefs = useRef(new Map<string, HTMLDivElement>());
  const composerResizeRef = useRef<ComposerResizeState | null>(null);
  const composerManualHeightRef = useRef(false);
  const [traceExpandedByTurn, setTraceExpandedByTurn] = useState<Record<string, boolean>>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [focusedTurnId, setFocusedTurnId] = useState<string | null>(latestConversationTurnId);
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [sessionMentionQuery, setSessionMentionQuery] = useState<string | null>(null);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [expandedAttachment, setExpandedAttachment] = useState<{
    name: string;
    kind: "image" | "video";
    path?: string;
    previewUrl: string;
    sourceUrl: string;
    sourceMimeType?: string;
    loading: boolean;
    width?: number;
    height?: number;
  } | null>(null);
  const voiceRecorderRef = useRef<VoiceRecorderState | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!expandedAttachment) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedAttachment(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expandedAttachment]);

  useEffect(() => {
    const backgroundColor = expandedAttachment
      ? theme === "dark" ? "#131615" : "#555957"
      : theme === "dark" ? "#171716" : "#f7f7f5";
    void window.desktop?.setWindowTheme(theme, backgroundColor);
  }, [expandedAttachment, theme]);

  const openMediaPreview = useCallback((attachment: { name: string; kind: "image" | "video"; path?: string; previewUrl: string }) => {
    const path = attachment.path;
    setExpandedAttachment({ ...attachment, sourceUrl: attachment.previewUrl, loading: Boolean(path) });
    if (!path || !window.desktop?.previewAttachmentFile) return;
    void window.desktop.previewAttachmentFile(path).then((file) => {
      if (file.kind !== "image" && file.kind !== "video") return;
      const sourceUrl = `data:${file.mimeType};base64,${file.content}`;
      setExpandedAttachment((current) => current?.path === path ? { ...current, sourceUrl, sourceMimeType: file.mimeType, loading: false } : current);
    }).catch(() => {
      setExpandedAttachment((current) => current?.path === path ? { ...current, loading: false } : current);
    });
  }, []);

  const fitMediaPreview = useCallback((mediaWidth: number, mediaHeight: number) => {
    if (!mediaWidth || !mediaHeight) return;
    const maxWidth = Math.min(window.innerWidth * 0.86, 1000) - 24;
    const maxHeight = Math.min(window.innerHeight * 0.78, 700) - 24;
    const scale = Math.min(maxWidth / mediaWidth, maxHeight / mediaHeight, 1);
    setExpandedAttachment((current) => current ? {
      ...current,
      width: Math.max(320, Math.round(mediaWidth * scale) + 24),
      height: Math.max(220, Math.round(mediaHeight * scale) + 24),
    } : current);
  }, []);

  const updateScrollToBottomVisibility = useCallback(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }
    const distanceToBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight;
    setShowScrollToBottom(distanceToBottom > MESSAGE_BOTTOM_THRESHOLD);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }
    messagesElement.scrollTo({ top: messagesElement.scrollHeight, behavior: "smooth" });
  }, []);
  const resizeComposer = useCallback((textarea: HTMLTextAreaElement, preserveManualHeight = true) => {
    if (preserveManualHeight && composerManualHeightRef.current) {
      return;
    }
    composerManualHeightRef.current = false;
    textarea.style.height = "auto";
    const contentHeight = textarea.scrollHeight;
    const automaticHeight = Math.min(
      Math.max(contentHeight, COMPOSER_MIN_HEIGHT),
      COMPOSER_AUTO_MAX_HEIGHT,
    );
    textarea.style.height = `${automaticHeight}px`;
  }, []);

  const setComposerHeight = useCallback((textarea: HTMLTextAreaElement, height: number) => {
    const computedStyle = window.getComputedStyle(textarea);
    const minHeight = Number.parseFloat(computedStyle.minHeight) || COMPOSER_MIN_HEIGHT;
    const parsedMaxHeight = Number.parseFloat(computedStyle.maxHeight);
    const maxHeight = Number.isFinite(parsedMaxHeight) ? parsedMaxHeight : height;
    textarea.style.height = `${Math.min(Math.max(height, minHeight), maxHeight)}px`;
  }, []);

  const handleComposerResizeStart = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const textarea = composerRef.current;
    if (!textarea) {
      return;
    }
    event.preventDefault();
    composerManualHeightRef.current = true;
    composerResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: textarea.getBoundingClientRect().height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handleComposerResizeMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = composerResizeRef.current;
    const textarea = composerRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId || !textarea) {
      return;
    }
    const height = resizeState.startHeight + resizeState.startY - event.clientY;
    setComposerHeight(textarea, height);
  }, [setComposerHeight]);

  const handleComposerResizeEnd = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = composerResizeRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    const textarea = composerRef.current;
    composerResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (textarea) {
      window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(Math.round(textarea.getBoundingClientRect().height)));
    }
  }, []);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    const storedHeight = Number(window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY));
    if (!Number.isFinite(storedHeight) || storedHeight <= 0) return;
    setComposerHeight(textarea, storedHeight);
    composerManualHeightRef.current = true;
  }, [activeSessionId, setComposerHeight]);

  useEffect(() => {
    if (!prompt && composerRef.current && !composerManualHeightRef.current) {
      resizeComposer(composerRef.current, false);
      setSessionMentionQuery(null);
    }
  }, [prompt, resizeComposer]);

  useEffect(() => {
    setTraceExpandedByTurn({});
  }, [activeSessionId]);

  useEffect(() => {
    if (latestConversationTurnId) {
      setFocusedTurnId(latestConversationTurnId);
    }
  }, [latestConversationTurnId]);

  useEffect(() => () => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(updateScrollToBottomVisibility);
    const observer = new ResizeObserver(updateScrollToBottomVisibility);
    observer.observe(messagesElement);
    const observeMessageChildren = () => {
      Array.from(messagesElement.children).forEach((child) => observer.observe(child));
    };
    observeMessageChildren();
    const mutationObserver = new MutationObserver(() => {
      observeMessageChildren();
      updateScrollToBottomVisibility();
    });
    mutationObserver.observe(messagesElement, { childList: true, subtree: true, characterData: true });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, [activeSessionId, updateScrollToBottomVisibility]);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    const composerElement = composerContainerRef.current;
    if (!messagesElement || !composerElement) return undefined;
    const syncComposerSpace = () => {
      const reservedHeight = Math.ceil(composerElement.getBoundingClientRect().height + 24);
      messagesElement.style.setProperty("--composer-reserved-height", `${reservedHeight}px`);
    };
    const observer = new ResizeObserver(syncComposerSpace);
    observer.observe(composerElement);
    syncComposerSpace();
    return () => {
      observer.disconnect();
      messagesElement.style.removeProperty("--composer-reserved-height");
    };
  }, [activeSessionId]);

  const handleEditSteer = useCallback(() => {
    onEditSteer();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [onEditSteer]);

  const messageGroups = useMemo<ConversationMessageGroup[]>(() => {
    const groups: ConversationMessageGroup[] = [];
    const groupsByTurn = new Map<string, ConversationMessageGroup>();
    for (const message of messages) {
      if (!message.turnId) {
        groups.push({ key: message.id, turnId: null, messages: [message] });
        continue;
      }
      const existing = groupsByTurn.get(message.turnId);
      if (existing) {
        existing.messages.push(message);
        continue;
      }
      const group = { key: message.turnId, turnId: message.turnId, messages: [message] };
      groupsByTurn.set(message.turnId, group);
      groups.push(group);
    }
    return groups;
  }, [messages]);

  const navigableTurns = useMemo(
    () => messageGroups.filter((group): group is ConversationMessageGroup & { turnId: string } => Boolean(group.turnId)),
    [messageGroups],
  );

  const scrollToTurn = useCallback((turnId: string) => {
    const element = turnRefs.current.get(turnId);
    if (!element) {
      return;
    }
    setFocusedTurnId(turnId);
    setHighlightedTurnId(null);
    window.requestAnimationFrame(() => setHighlightedTurnId(turnId));
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedTurnId(null);
      highlightTimerRef.current = null;
    }, 900);
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const composerHUDEnabled = Boolean(activeSessionId) && Boolean(activeTurnId);

  const toggleVoice = useCallback(async () => {
    if (isListening) { voiceRecorderRef.current?.recorder.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceStatus("当前环境无法访问麦克风");
      return;
    }
    let pendingStream: MediaStream | undefined;
    try {
      if (typeof MediaRecorder === "undefined") throw new Error("当前环境不支持录音");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      pendingStream = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const state: VoiceRecorderState = { recorder, stream, chunks: [] };
      voiceRecorderRef.current = state;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) state.chunks.push(event.data); };
      recorder.onstop = () => {
        void (async () => {
          setIsListening(false);
          setIsTranscribing(true);
          voiceRecorderRef.current = null;
          stream.getTracks().forEach((track) => track.stop());
          if (state.chunks.length === 0) { setIsTranscribing(false); setVoiceStatus("没有录到声音"); return; }
          setVoiceStatus("正在使用本地语音引擎和模型...");
          let audioContext: AudioContext | undefined;
          try {
            const context = new AudioContext();
            audioContext = context;
            const encoded = await new Blob(state.chunks, { type: recorder.mimeType }).arrayBuffer();
            const decoded = await context.decodeAudioData(encoded);
            const wav = encodeWav(decoded);
            const result = await window.desktop?.voiceTranscribe(arrayBufferToBase64(wav));
            if (!result?.text) throw new Error("未识别到文字");
            onPromptChange(`${prompt}${prompt ? " " : ""}${traditionalToSimplified(result.text)}`);
            setVoiceStatus("已识别");
          } catch (error) {
            const detail = formatVoiceError(error);
            console.error("[voice] 离线识别失败", error);
            setVoiceStatus(`离线识别失败：${detail}`);
          } finally {
            setIsTranscribing(false);
            await audioContext?.close().catch(() => undefined);
          }
        })();
      };
      recorder.start(250);
      setIsListening(true);
      setVoiceStatus("正在录音，点击麦克风停止");
    } catch (error) {
      pendingStream?.getTracks().forEach((track) => track.stop());
      voiceRecorderRef.current = null;
      setVoiceStatus(`录音启动失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }, [isListening, onPromptChange, prompt]);

  useEffect(() => () => {
    voiceRecorderRef.current?.recorder.stop();
    voiceRecorderRef.current?.stream.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    if (!showAttachmentMenu && sessionMentionQuery === null && !showModelMenu) return undefined;
    const handleOutsidePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".composer-attach-wrap, .session-mention-menu, .composer-model-button, .composer-model-menu")) return;
      setShowAttachmentMenu(false);
      setSessionMentionQuery(null);
      setShowModelMenu(false);
      window.requestAnimationFrame(() => attachmentTriggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [sessionMentionQuery, showAttachmentMenu, showModelMenu]);

  const mentionSessions = useMemo(() => {
    if (sessionMentionQuery === null) return [];
    const query = sessionMentionQuery.trim().toLocaleLowerCase();
    return sessions
      .filter((session) => session.session_id !== activeSessionId)
      .filter((session) => !query || `${session.title ?? ""} ${session.session_id}`.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [activeSessionId, sessionMentionQuery, sessions]);
  const selectedModelLabel = modelOptions.find((item) => item.id === model)?.label ?? model;

  return (
    <section className="conversation-panel">
      <header className="panel-header">
        <div>
          <span className="eyebrow">{activeSession ? activeSession.workspace : "未选择工作区"}</span>
          <h1>Agent 会话</h1>
          {turnElapsedSeconds !== null && (
            <div className="turn-meta">
              <span>{activeTurnId ? "耗时" : "上次耗时"} {durationLabel(turnElapsedSeconds)}</span>
              {turnPhase && <span>{turnPhase}</span>}
            </div>
          )}
        </div>
        <div className="header-actions">
          <button className="icon-button" title="打开 RAG 知识库管理" aria-label="打开 RAG 知识库管理" onClick={() => void window.desktop?.openRagManager()}><Database size={17} /></button>
          <button className="icon-button" title={toolPanelVisible ? "隐藏工具面板" : "显示工具面板"} aria-label={toolPanelVisible ? "隐藏工具面板" : "显示工具面板"} onClick={onToggleToolPanel}><>{toolPanelVisible ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</></button>
        </div>
      </header>

      <div className="messages-region">
        <div
          ref={messagesRef}
          className="messages"
          aria-live="polite"
          onScroll={updateScrollToBottomVisibility}
        >
          {hasOlderHistory && (
            <button
              className="history-load-button"
              type="button"
              onClick={onLoadOlderHistory}
              disabled={loadingOlderHistory}
            >
              {loadingOlderHistory ? "正在加载更早历史..." : "加载更早历史"}
            </button>
          )}
          {messages.length === 0 && <div className="empty-state"><img src={logoUrl} alt="Buffeed" /><p>我们来创造些什么？</p></div>}
          {messageGroups.map((group) => {
          const isLatestTurn = group.turnId !== null && group.turnId === latestConversationTurnId;
          const turnEvents = isLatestTurn
            ? latestConversationEvents
            : group.turnId
              ? conversationEvents.filter((event) => event.turnId === group.turnId)
              : [];
          const turnOperations = isLatestTurn
            ? taskHUD.operations
              : deriveTaskHUD(turnEvents, [], false).operations;
          const turnTimestamp = [...turnEvents].reverse().find((event) => event.createdAt !== null)?.createdAt ?? null;
          const traceExpandedForTurn = group.turnId
            ? isLatestTurn
              ? traceExpanded
              : traceExpandedByTurn[group.turnId] ?? false
            : false;
          const toggleTraceForTurn = group.turnId
            ? isLatestTurn
              ? onToggleTrace
              : () => setTraceExpandedByTurn((current) => ({
                ...current,
                [group.turnId as string]: !(current[group.turnId as string] ?? false),
              }))
            : () => undefined;
          const assistantMessages = group.messages.filter((message) => message.role !== "user");
          return (
            <div
              className="message-group"
              key={group.key}
              ref={(element) => {
                if (!group.turnId) {
                  return;
                }
                if (element) {
                  turnRefs.current.set(group.turnId, element);
                } else {
                  turnRefs.current.delete(group.turnId);
                }
              }}
            >
              {group.messages.filter((message) => message.role === "user").map((message) => (
                <UserMessage
                  key={message.id}
                  text={message.text}
                  highlighted={highlightedTurnId === group.turnId}
                  attachments={message.attachments}
                  onPreviewAttachment={openMediaPreview}
                />
              ))}
              {group.turnId && activeTurnId === group.turnId && (
                <div className="turn-running-indicator" role="status" aria-label="当前回合正在执行">
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                  <span>正在执行</span>
                </div>
              )}
              {group.turnId && turnEvents.length > 0 && (
                <ExecutionTrace
                  events={turnEvents}
                  operations={turnOperations}
                  baseUrl={agentApi}
                  sessionId={activeSessionId}
                  expanded={traceExpandedForTurn}
                  active={activeTurnId === group.turnId}
                  elapsedSeconds={isLatestTurn ? turnElapsedSeconds : null}
                  onToggle={toggleTraceForTurn}
                />
              )}
              {assistantMessages.map((message, assistantIndex) => (
                <article className={`message ${message.role} ${isLatestTurn ? "latest-turn" : ""}`} key={message.id}>
                  <div className="message-content">
                    <MarkdownContent text={message.text} />
                  </div>
                  {group.turnId && group.turnId !== activeTurnId && assistantIndex === assistantMessages.length - 1 && taskHUDByTurn[group.turnId]?.summary && (
                    <div className="message-summary-hud">
                      <TaskHUD
                        state={taskHUDByTurn[group.turnId]}
                        variant="summary"
                        enabled
                        onRevert={onRevertChanges}
                        onReview={(path) => onReviewChanges(group.turnId ?? undefined, path)}
                      />
                    </div>
                  )}
                  {(!group.turnId || group.turnId !== activeTurnId) && (
                    <div className="message-copy-row message-copy-row-assistant assistant-action-row">
                      <CopyButton text={message.text} label="复制回复" className="message-copy-button" />
                      {group.turnId && (
                        <button
                          className="message-copy-button fork-button"
                          type="button"
                          title="Fork 当前回合"
                          aria-label="Fork 当前回合"
                          onClick={() => void onForkTurn(group.turnId as string)}
                        >
                          <GitFork size={14} />
                        </button>
                      )}
                      {turnTimestamp !== null && <time className="message-turn-time">{turnTimeLabel(turnTimestamp)}</time>}
                    </div>
                  )}
                </article>
              ))}
            </div>
          );
          })}
          {(activeTurnId || turnSubmitting) && (
            <div className="processing-line" role="status" aria-live="polite">
              <span className="thinking-text">正在思考...</span>
              {turnPhase && <span className="processing-phase">{turnPhase}</span>}
              {turnElapsedSeconds !== null && <time>耗时 {durationLabel(turnElapsedSeconds)}</time>}
            </div>
          )}
        </div>
        {navigableTurns.length > 0 && (
          <nav className="turn-router" aria-label="回合导航">
            {navigableTurns.map((group, index) => (
              <button
                className={`turn-router-button ${focusedTurnId === group.turnId ? "is-active" : ""}`}
                key={group.turnId}
                type="button"
                title={`跳转到第 ${index + 1} 回合`}
                aria-label={`跳转到第 ${index + 1} 回合`}
                aria-current={focusedTurnId === group.turnId ? "true" : undefined}
                onClick={() => scrollToTurn(group.turnId)}
              >
                <span aria-hidden="true" />
              </button>
            ))}
          </nav>
        )}
        {showScrollToBottom && (
          <button
            className="scroll-to-bottom-button"
            type="button"
            title="回到最新消息"
            aria-label="回到最新消息"
            onClick={handleScrollToBottom}
          >
            <ArrowDown size={18} />
          </button>
        )}
      </div>

      <footer ref={composerContainerRef} className="composer">
        <div className="composer-task-hud">
          <TaskHUD
            state={taskHUD}
            variant="running"
            enabled={composerHUDEnabled}
            onRevert={onRevertChanges}
            onReview={(path) => onReviewChanges(activeTurnId ?? undefined, path)}
          />
        </div>
        {approvals.length > 0 && <ApprovalPanel approvals={approvals} onResolveApproval={onResolveApproval} />}
        {pendingSteerText && (
          <div className="steer-confirmation" role="status" aria-live="polite">
            <span className="steer-confirmation-message" title={pendingSteerText}>
              {pendingSteerText}
            </span>
            <div className="steer-confirmation-actions">
              <button
                className="steer-confirmation-button"
                type="button"
                title="编辑追加消息"
                aria-label="编辑追加消息"
                onClick={handleEditSteer}
                disabled={turnSubmitting}
              >
                <Pencil size={14} />
              </button>
              <button
                className="steer-confirmation-button primary"
                type="button"
                title="发送追加消息"
                aria-label="发送追加消息"
                onClick={() => void onConfirmSteer()}
                disabled={turnSubmitting}
              >
                <SendHorizontal size={14} />
              </button>
              <button
                className="steer-confirmation-button danger"
                type="button"
                title="取消追加消息"
                aria-label="取消追加消息"
                onClick={onCancelSteer}
                disabled={turnSubmitting}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        )}
        <div className="composer-entry">
          <div className={`composer-field ${attachments.length > 0 ? "has-attachments" : ""}`}>
            {messages.length === 0 ? <button className="composer-project-button" type="button" onClick={() => void onCreateSession()}><FolderOpen size={15} /> 选择项目</button> : null}
            {attachments.length > 0 ? <div className="composer-attachment-tray"><div className="composer-attachments" aria-label="待发送附件">{attachments.map((item) => {
              const canPreview = item.kind !== "folder" && item.kind !== "history" && Boolean(item.path);
              return <div className={`composer-attachment ${item.previewUrl ? "has-preview" : ""}`} key={item.id}>
                <button className="composer-attachment-open" type="button" title={item.previewUrl ? "放大预览" : canPreview ? "打开文件预览" : item.kind === "history" ? "会话历史" : "文件夹不可预览"} onClick={() => {
                  if (item.previewUrl && (item.kind === "image" || item.kind === "video")) {
                    openMediaPreview({ name: item.name, kind: item.kind, path: item.path, previewUrl: item.previewUrl });
                  } else if (canPreview && item.path) {
                    onOpenAttachment(item.path);
                  }
                }} disabled={!item.previewUrl && !canPreview}>
                  {item.previewUrl ? <img src={item.previewUrl} alt={item.name} /> : <span className="composer-attachment-kind">{item.kind === "folder" ? "文件夹" : item.kind === "history" ? "历史" : item.kind === "video" ? "视频" : item.kind === "image" ? "图片" : "文件"}</span>}
                </button>
                <button className="composer-attachment-remove" type="button" title="移除附件" aria-label={`移除 ${item.name}`} onClick={() => onRemoveAttachment(item.id)}><X size={12} /></button>
              </div>;
            })}</div></div> : null}
            <textarea
              ref={composerRef}
              value={prompt}
              onChange={(event) => {
                resizeComposer(event.currentTarget);
                const nextPrompt = event.currentTarget.value;
                onPromptChange(nextPrompt);
                const mention = nextPrompt.match(/(?:^|\s)@([^\s@]*)$/);
                setSessionMentionQuery(mention ? mention[1] : null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSessionMentionQuery(null);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  if (sessionMentionQuery !== null && mentionSessions.length > 0) {
                    event.preventDefault();
                    const session = mentionSessions[0];
                    setSessionMentionQuery(null);
                    onPromptChange(prompt.replace(/(?:^|\s)@[^\s@]*$/, "").trimEnd());
                    void Promise.resolve(onAddSessionHistory(session.session_id)).catch((error: unknown) => setVoiceStatus(error instanceof Error ? error.message : "会话历史导入失败"));
                    return;
                  }
                  event.preventDefault();
                  void onSendTurn();
                }
              }}
              onPaste={(event) => {
                const hasImage = event.clipboardData.types.some((type) => type.startsWith("image/"))
                  || Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"))
                  || Array.from(event.clipboardData.files).some((file) => file.type.startsWith("image/"));
                if (hasImage) {
                  event.preventDefault();
                  void Promise.resolve(onAddClipboardImage()).catch((error: unknown) => {
                    setVoiceStatus(error instanceof Error ? error.message : "图片读取失败");
                  });
                }
              }}
              placeholder="输入任务..."
              disabled={turnSubmitting || Boolean(pendingSteerText)}
            />
            {sessionMentionQuery !== null && mentionSessions.length > 0 ? <div className="session-mention-menu" role="listbox" aria-label="匹配会话">{mentionSessions.map((session) => <button key={session.session_id} type="button" role="option" onClick={() => { setSessionMentionQuery(null); onPromptChange(prompt.replace(/(?:^|\s)@[^\s@]*$/, "").trimEnd()); void Promise.resolve(onAddSessionHistory(session.session_id)).catch((error: unknown) => setVoiceStatus(error instanceof Error ? error.message : "会话历史导入失败")); }}><strong>{session.title || "未命名会话"}</strong><small>{session.workspace}</small></button>)}</div> : null}
            <div className="composer-bottom-actions">
              <div className="composer-attach-wrap"><button ref={attachmentTriggerRef} className="composer-icon-button" type="button" title="添加文件或会话历史" aria-label="添加附件" onClick={() => setShowAttachmentMenu((value) => !value)}><Plus size={18} /></button>{showAttachmentMenu ? <div className="composer-attachment-menu"><button type="button" onClick={() => { setShowAttachmentMenu(false); void Promise.resolve(onAddInputFiles("file")).catch((error: unknown) => setVoiceStatus(error instanceof Error ? error.message : "文件选择失败")); window.requestAnimationFrame(() => attachmentTriggerRef.current?.focus()); }}>选择文件</button><button type="button" onClick={() => { setShowAttachmentMenu(false); setSessionMentionQuery(""); onPromptChange(`${prompt}${prompt && !prompt.endsWith(" ") ? " " : ""}@`); window.requestAnimationFrame(() => composerRef.current?.focus()); }}>引入其他会话（输入 @）</button></div> : null}</div>
              {voiceStatus ? <span className="voice-status" title={voiceStatus}>{voiceStatus}</span> : null}
              <button className={`composer-icon-button voice-button ${isListening ? "is-listening" : ""} ${isTranscribing ? "is-transcribing" : ""}`} type="button" title={isListening ? "停止语音输入" : isTranscribing ? "正在识别语音" : "语音输入"} aria-label={isListening ? "停止语音输入" : isTranscribing ? "正在识别语音" : "语音输入"} onClick={toggleVoice} disabled={!activeSessionId || turnSubmitting || Boolean(pendingSteerText) || isTranscribing}>{isTranscribing ? <LoaderCircle className="spin" size={17} /> : isListening ? <MicOff size={17} /> : <Mic size={17} />}</button>
            </div>
            <button
              type="button"
              className="composer-resize-handle"
              title="调整输入框高度"
              aria-label="调整输入框高度"
              disabled={!activeSessionId || turnSubmitting || Boolean(pendingSteerText)}
              onPointerDown={handleComposerResizeStart}
              onPointerMove={handleComposerResizeMove}
              onPointerUp={handleComposerResizeEnd}
              onPointerCancel={handleComposerResizeEnd}
            >
              <ChevronsUpDown size={15} />
            </button>
            <button
              ref={modelTriggerRef}
              className="composer-model-button"
              type="button"
              title="切换模型"
              aria-label="切换模型"
              aria-expanded={showModelMenu}
              onClick={() => setShowModelMenu((visible) => !visible)}
              disabled={turnSubmitting || Boolean(pendingSteerText)}
            >
              <span>{selectedModelLabel}</span>
              <ChevronDown size={14} />
            </button>
            {showModelMenu ? <div className="composer-model-menu" role="menu" aria-label="选择模型">
              {modelOptions.map((item) => <button className={model === item.id ? "is-active" : ""} key={item.id} type="button" role="menuitem" onClick={() => { onModelChange(item.id); setShowModelMenu(false); }}>{item.label}</button>)}
            </div> : null}
            <button
              className={`primary-button send-button ${activeTurnId ? "is-stop" : ""}`}
              title={activeTurnId ? "停止当前回合" : "发送任务"}
              aria-label={activeTurnId ? "停止当前回合" : "发送任务"}
              onClick={() => void (activeTurnId ? onCancelTurn() : onSendTurn())}
              disabled={activeTurnId ? false : (!prompt.trim() && attachments.length === 0) || !activeSessionId || turnSubmitting || Boolean(pendingSteerText)}
            >
              {activeTurnId ? <><Square size={16} fill="currentColor" /> 停止</> : <><SendHorizontal size={17} /> 发送</>}
            </button>
          </div>
        </div>
      </footer>
      {expandedAttachment && (
        <div
          className="media-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label="媒体附件预览"
          onClick={(event) => {
            if (event.target === event.currentTarget) setExpandedAttachment(null);
          }}
        >
          <div
            className="media-preview-dialog"
            style={expandedAttachment.width && expandedAttachment.height ? {
              width: expandedAttachment.width,
              height: expandedAttachment.height,
            } : undefined}
          >
            <button
              className="media-preview-close"
              type="button"
              title="关闭预览"
              aria-label="关闭预览"
              onClick={() => setExpandedAttachment(null)}
            >
              <X size={18} />
            </button>
            {expandedAttachment.loading || expandedAttachment.kind === "image" || !expandedAttachment.sourceMimeType?.startsWith("video/") ? (
              <img
                src={expandedAttachment.sourceUrl}
                alt={expandedAttachment.name}
                onLoad={(event) => fitMediaPreview(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
              />
            ) : (
              <video
                src={expandedAttachment.sourceUrl}
                controls
                autoPlay={false}
                preload="metadata"
                onLoadedMetadata={(event) => fitMediaPreview(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
              />
            )}
            {expandedAttachment.loading && <span className="media-preview-loading">正在读取原始媒体...</span>}
            {expandedAttachment.kind === "video" && expandedAttachment.loading && <span className="media-preview-badge">视频截图</span>}
          </div>
        </div>
      )}
    </section>
  );
}
