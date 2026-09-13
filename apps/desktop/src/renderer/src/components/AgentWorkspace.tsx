import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import OpenCC from "opencc-js/t2cn";

import {
  ArrowDown,
  ArrowUp,
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
import { deriveTaskHUD, terminalPhase, type HUDOperation, type TaskHUDState } from "../domains/hud";
import { durationLabel, turnTimeLabel } from "../utils/format";
import { CopyButton } from "./CopyButton";
import { ExecutionTrace } from "./ExecutionTrace";
import { MarkdownContent } from "./MarkdownContent";
import { TaskHUD } from "./TaskHUD";
import { ApprovalPanel } from "./ApprovalPanel";
import type { Approval } from "../domains/agent";
import type { ComposerAttachment } from "../hooks/useAgentWorkspace";
import type { ReasoningEffort, TurnModel, TurnModelOption } from "../services/agentApi";
import logoUrl from "../assets/buffeed-logo.png";

type AgentWorkspaceProps = {
  theme: "light" | "dark";
  agentApi: string;
  activeSession: Session | null;
  sessions: Session[];
  activeSessionId: string | null;
  approvals: Approval[];
  messages: ChatMessage[];
  streamingMessageIds: ReadonlySet<string>;
  streamingPreviewOrders: Readonly<Record<string, number>>;
  latestConversationTurnId: string | null;
  latestConversationEvents: StreamEvent[];
  conversationEvents: StreamEvent[];
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
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onToggleTrace: () => void;
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
const EMPTY_EVENTS: StreamEvent[] = [];
const NOOP = () => undefined;

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

const UserMessage = memo(function UserMessage({
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
});

const StreamingMessage = memo(function StreamingMessage({ text }: { text: string }) {
  return <div className="streaming-message" aria-live="polite">{text}</div>;
});

type AssistantMessageProps = {
  message: ChatMessage;
  isLatestTurn: boolean;
  isStreaming: boolean;
  showTaskHUD: boolean;
  showActions: boolean;
  turnId: string | null;
  turnTimestamp: number | null;
  taskHUDState?: TaskHUDState;
  onRevertChanges: () => void | Promise<void>;
  onReviewChanges: (turnId?: string, path?: string) => void | Promise<void>;
  onForkTurn: (turnId: string) => void | Promise<void>;
};

function sameTaskHUDState(previous: TaskHUDState | undefined, next: TaskHUDState | undefined): boolean {
  if (!previous || !next) return previous === next;
  const previousSummary = previous.summary;
  const nextSummary = next.summary;
  return previous.phase === next.phase
    && previous.currentStep === next.currentStep
    && previous.totalSteps === next.totalSteps
    && previous.cancellationNote === next.cancellationNote
    && previous.fileChanges.length === next.fileChanges.length
    && previous.fileChanges.every((file, index) => {
      const nextFile = next.fileChanges[index];
      if (!nextFile
        || file.path !== nextFile.path
        || file.additions !== nextFile.additions
        || file.deletions !== nextFile.deletions
        || file.status !== nextFile.status
        || file.hunks.length !== nextFile.hunks.length
        || (file.diffLines?.length ?? 0) !== (nextFile.diffLines?.length ?? 0)) {
        return false;
      }
      return file.hunks.every((hunk, hunkIndex) => {
        const nextHunk = nextFile.hunks[hunkIndex];
        return hunk.startLine === nextHunk?.startLine && hunk.endLine === nextHunk?.endLine;
      }) && (file.diffLines ?? []).every((line, lineIndex) => {
        const nextLine = nextFile.diffLines?.[lineIndex];
        return line.kind === nextLine?.kind
          && line.oldLine === nextLine?.oldLine
          && line.newLine === nextLine?.newLine
          && line.text === nextLine?.text;
      });
    })
    && previous.operations.length === next.operations.length
    && previous.operations.every((operation, index) => {
      const nextOperation = next.operations[index];
      return operation.id === nextOperation?.id
        && operation.status === nextOperation.status
        && operation.resultEventId === nextOperation.resultEventId
        && operation.durationSeconds === nextOperation.durationSeconds
        && operation.detail === nextOperation.detail;
    })
    && previousSummary?.totalFiles === nextSummary?.totalFiles
    && previousSummary?.totalAdditions === nextSummary?.totalAdditions
    && previousSummary?.totalDeletions === nextSummary?.totalDeletions;
}

function assistantMessageEqual(previous: AssistantMessageProps, next: AssistantMessageProps): boolean {
  return previous.message === next.message
    && previous.isLatestTurn === next.isLatestTurn
    && previous.isStreaming === next.isStreaming
    && previous.showTaskHUD === next.showTaskHUD
    && previous.showActions === next.showActions
    && previous.turnId === next.turnId
    && previous.turnTimestamp === next.turnTimestamp
    && sameTaskHUDState(previous.taskHUDState, next.taskHUDState);
}

const AssistantMessage = memo(function AssistantMessage({
  message,
  isLatestTurn,
  isStreaming,
  showTaskHUD,
  showActions,
  turnId,
  turnTimestamp,
  taskHUDState,
  onRevertChanges,
  onReviewChanges,
  onForkTurn,
}: AssistantMessageProps) {
  const handleReview = useCallback((path?: string) => {
    void onReviewChanges(turnId ?? undefined, path);
  }, [onReviewChanges, turnId]);
  const handleFork = useCallback(() => {
    if (turnId) void onForkTurn(turnId);
  }, [onForkTurn, turnId]);
  return (
    <article className={`message ${message.role} ${isLatestTurn ? "latest-turn" : ""}`}>
      {message.recovered && (
        <div className="message-recovery-note" role="status">
          运行时重启，以下为已保存的部分回答；本回合已中断
        </div>
      )}
      <div className="message-content">
        {isStreaming ? <StreamingMessage text={message.text} /> : <MarkdownContent text={message.text} />}
      </div>
      {showTaskHUD && taskHUDState?.summary && (
        <div className="message-summary-hud">
          <TaskHUD
            state={taskHUDState}
            variant="summary"
            enabled
            onRevert={onRevertChanges}
            onReview={handleReview}
          />
        </div>
      )}
      {showActions && (
        <div className="message-copy-row message-copy-row-assistant assistant-action-row">
          <CopyButton text={message.text} label="复制回复" className="message-copy-button" />
          {turnId && (
            <button
              className="message-copy-button fork-button"
              type="button"
              title="Fork 当前回合"
              aria-label="Fork 当前回合"
              onClick={handleFork}
            >
              <GitFork size={14} />
            </button>
          )}
          {turnTimestamp !== null && <time className="message-turn-time">{turnTimeLabel(turnTimestamp)}</time>}
        </div>
      )}
    </article>
  );
}, assistantMessageEqual);

export function AgentWorkspace({
  theme,
  agentApi,
  activeSession,
  sessions,
  activeSessionId,
  approvals,
  messages,
  streamingMessageIds,
  streamingPreviewOrders,
  latestConversationTurnId,
  latestConversationEvents,
  conversationEvents,
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
  reasoningEffort,
  onReasoningEffortChange,
  onToggleTrace,
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
  const [showModelChoices, setShowModelChoices] = useState(false);
  const [showEffortMenu, setShowEffortMenu] = useState(false);
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
  const onRevertChangesRef = useRef(onRevertChanges);
  const onReviewChangesRef = useRef(onReviewChanges);
  const onForkTurnRef = useRef(onForkTurn);
  const onToggleTraceRef = useRef(onToggleTrace);
  const taskHUDStateCacheRef = useRef(new Map<string, TaskHUDState>());
  const turnEventsCacheRef = useRef(new Map<string, StreamEvent[]>());
  const turnOperationsCacheRef = useRef(new Map<string, { events: StreamEvent[]; operations: HUDOperation[] }>());
  const historicalTraceToggleRef = useRef(new Map<string, () => void>());
  onRevertChangesRef.current = onRevertChanges;
  onReviewChangesRef.current = onReviewChanges;
  onForkTurnRef.current = onForkTurn;
  onToggleTraceRef.current = onToggleTrace;
  const stableRevertChanges = useCallback(() => onRevertChangesRef.current(), []);
  const stableReviewChanges = useCallback((turnId?: string, path?: string) => onReviewChangesRef.current(turnId, path), []);
  const stableForkTurn = useCallback((turnId: string) => onForkTurnRef.current(turnId), []);

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
    taskHUDStateCacheRef.current.clear();
    turnEventsCacheRef.current.clear();
    turnOperationsCacheRef.current.clear();
    historicalTraceToggleRef.current.clear();
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
      const regionElement = messagesElement.parentElement;
      const regionBottom = regionElement?.getBoundingClientRect().bottom
        ?? composerElement.getBoundingClientRect().bottom;
      const floatingElements = composerElement.querySelectorAll<HTMLElement>(
        ".composer-task-hud, .detail-section, .steer-confirmation",
      );
      const topEdge = Array.from(floatingElements).reduce(
        (currentTop, element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0
            ? Math.min(currentTop, bounds.top)
            : currentTop;
        },
        composerElement.getBoundingClientRect().top,
      );
      const reservedHeight = Math.ceil(Math.max(0, regionBottom - topEdge) + 24);
      messagesElement.style.setProperty("--composer-reserved-height", `${reservedHeight}px`);
      regionElement?.style.setProperty("--composer-reserved-height", `${reservedHeight}px`);
    };
    const observer = new ResizeObserver(syncComposerSpace);
    observer.observe(composerElement);
    composerElement.querySelectorAll<HTMLElement>(
      ".composer-task-hud, .detail-section, .steer-confirmation",
    ).forEach((element) => observer.observe(element));
    syncComposerSpace();
    return () => {
      observer.disconnect();
      messagesElement.style.removeProperty("--composer-reserved-height");
      messagesElement.parentElement?.style.removeProperty("--composer-reserved-height");
    };
  }, [activeSessionId]);

  const handleEditSteer = useCallback(() => {
    onEditSteer();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [onEditSteer]);

  const messageGroupCacheRef = useRef<ConversationMessageGroup[]>([]);
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
    const previousByKey = new Map(messageGroupCacheRef.current.map((group) => [group.key, group]));
    const stableGroups = groups.map((group) => {
      const previous = previousByKey.get(group.key);
      if (
        previous
        && previous.turnId === group.turnId
        && previous.messages.length === group.messages.length
        && previous.messages.every((message, index) => message === group.messages[index])
      ) {
        return previous;
      }
      return group;
    });
    messageGroupCacheRef.current = stableGroups;
    return stableGroups;
  }, [messages]);

  const virtualizer = useVirtualizer({
    count: messageGroups.length,
    getScrollElement: () => messagesRef.current,
    estimateSize: () => 180,
    getItemKey: (index) => messageGroups[index]?.key ?? index,
    overscan: 6,
  });

  const getStableTaskHUDState = useCallback((turnId: string | null): TaskHUDState | undefined => {
    if (!turnId) return undefined;
    const next = taskHUDByTurn[turnId];
    if (!next) {
      taskHUDStateCacheRef.current.delete(turnId);
      return undefined;
    }
    const previous = taskHUDStateCacheRef.current.get(turnId);
    if (previous && sameTaskHUDState(previous, next)) return previous;
    taskHUDStateCacheRef.current.set(turnId, next);
    return next;
  }, [taskHUDByTurn]);

  const turnEventsByTurn = useMemo(() => {
    const nextEvents = new Map<string, StreamEvent[]>();
    for (const event of conversationEvents) {
      if (!event.turnId) continue;
      const eventsForTurn = nextEvents.get(event.turnId) ?? [];
      eventsForTurn.push(event);
      nextEvents.set(event.turnId, eventsForTurn);
    }
    const stableEvents = new Map<string, StreamEvent[]>();
    for (const [turnId, eventsForTurn] of nextEvents) {
      const previous = turnEventsCacheRef.current.get(turnId);
      const stable = previous
        && previous.length === eventsForTurn.length
        && previous.every((event, index) => event === eventsForTurn[index])
        ? previous
        : eventsForTurn;
      stableEvents.set(turnId, stable);
    }
    turnEventsCacheRef.current = stableEvents;
    return stableEvents;
  }, [conversationEvents]);

  const traceOnlyAssistantIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of conversationEvents) {
      if (event.type !== "assistant.message") continue;
      const phase = String(event.payload.phase ?? "final");
      if (phase !== "planning" && phase !== "finding" && event.payload.stream_retracted !== true) continue;
      const streamId = String(event.payload.stream_id ?? "").trim();
      ids.add(streamId || event.event_id);
    }
    return ids;
  }, [conversationEvents]);

  const traceOnlyAssistantTexts = useMemo(() => {
    const texts = new Set<string>();
    for (const event of conversationEvents) {
      if (event.type !== "assistant.message") continue;
      const phase = String(event.payload.phase ?? "final");
      if (phase !== "planning" && phase !== "finding") continue;
      const text = String(event.payload.text ?? "").trim();
      if (text) texts.add(`${event.turnId ?? ""}:${text}`);
    }
    return texts;
  }, [conversationEvents]);

  const getStableTurnOperations = useCallback((turnId: string, turnEvents: StreamEvent[]): HUDOperation[] => {
    const previous = turnOperationsCacheRef.current.get(turnId);
    if (previous?.events === turnEvents) return previous.operations;
    const operations = deriveTaskHUD(turnEvents, [], false).operations;
    turnOperationsCacheRef.current.set(turnId, { events: turnEvents, operations });
    return operations;
  }, []);

  const getHistoricalTraceToggle = useCallback((turnId: string): (() => void) => {
    const existing = historicalTraceToggleRef.current.get(turnId);
    if (existing) return existing;
    const toggle = () => setTraceExpandedByTurn((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? false),
    }));
    historicalTraceToggleRef.current.set(turnId, toggle);
    return toggle;
  }, []);
  const stableToggleTrace = useCallback(() => onToggleTraceRef.current(), []);

  const navigableTurns = useMemo(
    () => messageGroups.filter((group): group is ConversationMessageGroup & { turnId: string } => Boolean(group.turnId)),
    [messageGroups],
  );

  const scrollToTurn = useCallback((turnId: string) => {
    const index = messageGroups.findIndex((group) => group.turnId === turnId);
    if (index < 0) {
      return;
    }
    setFocusedTurnId(turnId);
    setHighlightedTurnId(null);
    virtualizer.scrollToIndex(index, { align: "start", behavior: "smooth" });
    window.requestAnimationFrame(() => setHighlightedTurnId(turnId));
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedTurnId(null);
      highlightTimerRef.current = null;
    }, 900);
  }, [messageGroups, virtualizer]);

  const composerHUDEnabled = Boolean(activeSessionId) && Boolean(activeTurnId);
  const canCancelTurn = Boolean(activeTurnId);

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
    if (!showAttachmentMenu && sessionMentionQuery === null && !showModelMenu && !showModelChoices && !showEffortMenu) return undefined;
    const handleOutsidePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".composer-attach-wrap, .session-mention-menu, .composer-model-button, .composer-model-menu, .composer-effort-button, .composer-effort-menu")) return;
      setShowAttachmentMenu(false);
      setSessionMentionQuery(null);
      setShowModelMenu(false);
      setShowModelChoices(false);
      setShowEffortMenu(false);
      window.requestAnimationFrame(() => attachmentTriggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [sessionMentionQuery, showAttachmentMenu, showEffortMenu, showModelChoices, showModelMenu]);

  const mentionSessions = useMemo(() => {
    if (sessionMentionQuery === null) return [];
    const query = sessionMentionQuery.trim().toLocaleLowerCase();
    return sessions
      .filter((session) => session.session_id !== activeSessionId)
      .filter((session) => !query || `${session.title ?? ""} ${session.session_id}`.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [activeSessionId, sessionMentionQuery, sessions]);
  const selectedModelLabel = modelOptions.find((item) => item.id === model)?.label ?? model;
  const selectedModel = modelOptions.find((item) => item.id === model);
  const canChooseReasoningEffort = (selectedModel?.reasoning_efforts.length ?? 0) > 0;

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
          {messages.length === 0 && <div className="empty-state"><img src={logoUrl} alt="Buffeed" /><p>我们来创造些什么？</p></div>}
          <div
            className="virtual-message-list"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
          {virtualizer.getVirtualItems().map((virtualItem) => {
          const group = messageGroups[virtualItem.index];
          if (!group) return null;
          const isLatestTurn = group.turnId !== null && group.turnId === latestConversationTurnId;
          const turnEvents = isLatestTurn
            ? latestConversationEvents
            : group.turnId
              ? turnEventsByTurn.get(group.turnId) ?? EMPTY_EVENTS
              : EMPTY_EVENTS;
          const turnIsTerminal = terminalPhase(turnEvents) !== null;
          const turnOperations = isLatestTurn
            ? taskHUD.operations
              : group.turnId
                ? getStableTurnOperations(group.turnId, turnEvents)
                : [];
          const turnTimestamp = [...turnEvents].reverse().find((event) => event.createdAt !== null)?.createdAt ?? null;
          const traceExpandedForTurn = group.turnId
            ? isLatestTurn
              ? traceExpanded
              : traceExpandedByTurn[group.turnId] ?? false
            : false;
          const toggleTraceForTurn = group.turnId
            ? isLatestTurn
              ? stableToggleTrace
              : getHistoricalTraceToggle(group.turnId)
            : NOOP;
          const assistantMessages = group.messages.filter((message) => (
            message.role !== "user"
            && !traceOnlyAssistantIds.has(message.id)
            && !traceOnlyAssistantTexts.has(`${message.turnId ?? ""}:${message.text.trim()}`)
          ));
          const streamingPreviews = assistantMessages
            .filter((message) => streamingMessageIds.has(message.id))
            .map((message) => ({
              id: message.id,
              text: message.text,
              order: streamingPreviewOrders[message.id] ?? Number.POSITIVE_INFINITY,
            }));
          const completedAssistantMessages = assistantMessages.filter((message) => !streamingMessageIds.has(message.id));
          return (
            <div
              className="virtual-message-row"
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
            <div
              className="message-group"
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
              {group.turnId && (turnEvents.length > 0 || streamingPreviews.length > 0) && (
                <ExecutionTrace
                  events={turnEvents}
                  operations={turnOperations}
                  streamingPreviews={streamingPreviews}
                  baseUrl={agentApi}
                  sessionId={activeSessionId}
                  expanded={traceExpandedForTurn}
                  active={activeTurnId === group.turnId}
                  elapsedSeconds={isLatestTurn ? turnElapsedSeconds : null}
                  onToggle={toggleTraceForTurn}
                />
              )}
              {completedAssistantMessages.map((message, assistantIndex) => {
                const isActiveTurn = group.turnId !== null && group.turnId === activeTurnId;
                const taskHUDState = getStableTaskHUDState(group.turnId);
                const isLastAssistantMessage = assistantIndex === completedAssistantMessages.length - 1;
                return (
                  <AssistantMessage
                    key={message.id}
                    message={message}
                    isLatestTurn={isLatestTurn}
                    isStreaming={false}
                    showTaskHUD={Boolean(group.turnId && !isActiveTurn && assistantIndex === completedAssistantMessages.length - 1)}
                    showActions={turnIsTerminal && isLastAssistantMessage}
                    turnId={group.turnId}
                    turnTimestamp={turnTimestamp}
                    taskHUDState={taskHUDState}
                    onRevertChanges={stableRevertChanges}
                    onReviewChanges={stableReviewChanges}
                    onForkTurn={stableForkTurn}
                  />
                );
              })}
            </div>
            </div>
          );
          })}
          </div>
          {(activeTurnId || turnSubmitting) && (
            <div className="processing-line" role="status" aria-live="polite">
              <span className="thinking-text">正在思考...</span>
              {turnPhase && <span className="processing-phase">{turnPhase}</span>}
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
              onClick={() => { setShowModelChoices(false); setShowEffortMenu(false); setShowModelMenu((visible) => !visible); }}
              disabled={turnSubmitting || Boolean(pendingSteerText)}
            >
              <span className="composer-model-name">{selectedModelLabel}</span>
              {canChooseReasoningEffort ? <><span className="composer-model-separator">·</span><span className="composer-effort-name">{reasoningEffort}</span></> : null}
              <ChevronDown size={14} />
            </button>
            {showModelMenu ? <div className="composer-model-menu composer-settings-menu" role="menu" aria-label="模型和思考强度">
              <button className="composer-menu-choice" type="button" role="menuitem" onClick={() => { setShowEffortMenu(false); setShowModelChoices((visible) => !visible); }}>
                <span>模型</span><strong>{selectedModelLabel}</strong><ChevronDown size={13} className={showModelChoices ? "is-open" : ""} />
              </button>
              {showModelChoices ? <div className="composer-submenu" role="group" aria-label="选择模型">
                {modelOptions.map((item) => <button className={model === item.id ? "is-active" : ""} key={item.id} type="button" role="menuitem" onClick={() => { onModelChange(item.id); setShowModelChoices(false); }}>{item.label}</button>)}
              </div> : null}
              <button
                className="composer-menu-choice"
                type="button"
                role="menuitem"
                aria-disabled={!canChooseReasoningEffort}
                onClick={() => { if (canChooseReasoningEffort) { setShowModelChoices(false); setShowEffortMenu((visible) => !visible); } }}
                disabled={turnSubmitting || Boolean(pendingSteerText) || !canChooseReasoningEffort}
              >
                <span>思考强度</span><strong>{canChooseReasoningEffort ? reasoningEffort : "不适用"}</strong><ChevronDown size={13} className={showEffortMenu ? "is-open" : ""} />
              </button>
              {showEffortMenu && canChooseReasoningEffort ? <div className="composer-submenu" role="group" aria-label="选择思考强度">
                {(["light", "medium", "high", "xhigh"] as const).map((effort) => (
                  <button className={reasoningEffort === effort ? "is-active" : ""} key={effort} type="button" role="menuitem" onClick={() => { onReasoningEffortChange(effort); setShowEffortMenu(false); }}>{effort}</button>
                ))}
              </div> : null}
            </div> : null}
            <button
              className={`primary-button send-button ${canCancelTurn ? "is-stop" : ""}`}
              title={canCancelTurn ? "停止当前回合" : "发送任务"}
              aria-label={canCancelTurn ? "停止当前回合" : "发送任务"}
              onClick={() => void (canCancelTurn ? onCancelTurn() : onSendTurn())}
              disabled={canCancelTurn ? false : (!prompt.trim() && attachments.length === 0) || !activeSessionId || turnSubmitting || Boolean(pendingSteerText)}
            >
              {canCancelTurn ? <Square size={14} fill="currentColor" /> : <ArrowUp size={18} strokeWidth={2.5} />}
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
