import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  FileCode2,
  ListChecks,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";

import type { HUDFileChange, TaskHUDState } from "../domains/hud";

type TaskHUDProps = {
  state: TaskHUDState;
  variant?: "running" | "summary";
  enabled: boolean;
  onRevert: () => void | Promise<void>;
  onReview: (path?: string) => void | Promise<void>;
};

function phaseIcon(phase: TaskHUDState["phase"]) {
  if (phase === "running") return <LoaderCircle size={14} className="hud-spin" />;
  if (phase === "failed") return <AlertCircle size={14} />;
  if (phase === "cancelled") return <Ban size={14} />;
  if (phase === "completed") return <CheckCircle2 size={14} />;
  return <ListChecks size={14} />;
}

function statusIcon(status: string) {
  if (status === "running") return <LoaderCircle size={12} className="hud-spin" />;
  if (status === "failed") return <AlertCircle size={12} />;
  if (status === "completed") return <CheckCircle2 size={12} />;
  return <span className="hud-step-dot" aria-hidden="true" />;
}

function stepStatusLabel(status: string): string {
  return status === "running" ? "进行中" : status === "completed" ? "已完成" : status === "failed" ? "失败" : "待开始";
}

function DiffPreview({ file }: { file: HUDFileChange }) {
  const lines = file.diffLines ?? [];
  return (
    <div className="hud-diff-lines" role="region" aria-label={`${file.path} 代码变更`}>
      {lines.length > 0 ? lines.map((line, index) => {
        const lineNumber = line.kind === "deletion" ? line.oldLine : line.newLine ?? line.oldLine;
        const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
        return (
          <div className={`hud-diff-line kind-${line.kind}`} key={`${line.kind}-${lineNumber ?? "x"}-${index}`}>
            <span className="hud-diff-line-number">{lineNumber ?? ""}</span>
            <code><b>{marker}</b>{line.text || " "}</code>
          </div>
        );
      }) : file.hunks.length > 0
        ? file.hunks.map((hunk) => <code className="hud-diff-anchor" key={`${hunk.startLine}-${hunk.endLine}`}>line {hunk.startLine}-{hunk.endLine}</code>)
        : <small>没有可用的代码差异</small>}
    </div>
  );
}

function estimateDiffPreviewHeight(file: HUDFileChange): number {
  const lineCount = file.diffLines?.length || file.hunks.length;
  const diffHeight = lineCount > 0 ? Math.min(300, Math.max(22, lineCount * 15)) : 24;
  return diffHeight + 58;
}

export function TaskHUD({ state, variant = "running", enabled, onRevert, onReview }: TaskHUDProps) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewTop, setPreviewTop] = useState<number | null>(null);
  const [previewPlacement, setPreviewPlacement] = useState<"above" | "below">("below");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);

  useEffect(() => {
    setDetailsOpen(state.phase !== "running" && state.phase !== "idle" && Boolean(state.summary));
  }, [state.phase, state.summary?.totalAdditions, state.summary?.totalDeletions, state.summary?.totalFiles]);

  const visibleFiles = showAllFiles ? state.fileChanges : state.fileChanges.slice(0, 3);
  const remainingFiles = Math.max(0, state.fileChanges.length - 3);
  const selectedFile = selectedPath ? state.fileChanges.find((file) => file.path === selectedPath) : null;
  const terminal = state.phase !== "running" && state.phase !== "idle";
  const displayTotalSteps = state.totalSteps > 0 ? state.totalSteps : terminal ? 1 : 0;
  const displayCurrentStep = state.totalSteps > 0 ? state.currentStep : terminal ? 1 : 0;

  const handleFileHover = (event: MouseEvent<HTMLButtonElement>, path: string) => {
    const fileRect = event.currentTarget.getBoundingClientRect();
    const region = event.currentTarget.closest<HTMLElement>(".hud-summary-files-hover-region");
    if (region) {
      const regionRect = region.getBoundingClientRect();
      const file = state.fileChanges.find((item) => item.path === path);
      const previewHeight = file ? estimateDiffPreviewHeight(file) : 320;
      const conversation = event.currentTarget.closest<HTMLElement>(".messages");
      const conversationRect = conversation?.getBoundingClientRect();
      const topBoundary = conversationRect?.top ?? 0;
      const bottomBoundary = conversationRect?.bottom ?? window.innerHeight;
      const spaceAbove = Math.max(0, fileRect.top - topBoundary);
      const spaceBelow = Math.max(0, bottomBoundary - fileRect.bottom);
      const placeAbove = spaceBelow < previewHeight && spaceAbove > spaceBelow;
      setPreviewPlacement(placeAbove ? "above" : "below");
      setPreviewTop(placeAbove
        ? fileRect.top - regionRect.top - previewHeight - 5
        : fileRect.bottom - regionRect.top + 5);
    }
    setSelectedPath(path);
  };

  if (!enabled) {
    return null;
  }

  if (variant === "summary") {
    if (!state.summary || state.fileChanges.length === 0) {
      return null;
    }
    const totals = state.summary ?? {
      totalFiles: state.fileChanges.length,
      totalAdditions: state.fileChanges.reduce((total, file) => total + file.additions, 0),
      totalDeletions: state.fileChanges.reduce((total, file) => total + file.deletions, 0),
    };
    return (
      <section className="task-hud task-hud-summary" aria-label="本回合代码变更总结">
        <div className="hud-summary-main">
          <div className="hud-summary-copy">
            <strong className="hud-summary-title">已编辑 {totals.totalFiles} 个文件</strong>
            <span className="hud-summary-totals">
              <b className="hud-additions">+{totals.totalAdditions}</b>
              <b className="hud-deletions">-{totals.totalDeletions}</b>
            </span>
          </div>
          <div className="hud-summary-actions">
            <button className="hud-action-button" type="button" title="撤销本会话新增变更" onClick={() => void onRevert()}>
              <RotateCcw size={13} /> 撤销
            </button>
            <button className="hud-action-button" type="button" title="创建 Code Review 请求" onClick={() => void onReview()}>
              <ClipboardCheck size={13} /> 审核
            </button>
          </div>
        </div>
        <div className="hud-summary-files-hover-region" onMouseLeave={() => setSelectedPath(null)}>
          {selectedFile && (
            <div className={`hud-diff-preview hud-diff-preview-hover placement-${previewPlacement}`} style={{ top: previewTop ?? 0 }}>
              <div className="hud-diff-preview-heading"><FileCode2 size={13} /><strong>{selectedFile.path}</strong></div>
              <DiffPreview file={selectedFile} />
            </div>
          )}
          <div className={`hud-summary-files ${showAllFiles ? "is-expanded" : ""}`}>
            {visibleFiles.map((file) => (
              <button className="hud-completion-file" type="button" key={file.path} onMouseEnter={(event) => handleFileHover(event, file.path)} onClick={() => void onReview(file.path)}>
                <span title={file.path}>{file.path}</span>
                <small><b className="hud-additions">+{file.additions}</b> <b className="hud-deletions">-{file.deletions}</b></small>
              </button>
            ))}
            {remainingFiles > 0 && (
              <button className="hud-more-files" type="button" onClick={() => setShowAllFiles((value) => !value)}>
                {showAllFiles ? "收起文件" : `再显示 ${remainingFiles} 个文件`}
              </button>
            )}
            {state.fileChanges.length === 0 && <small className="hud-summary-empty">本回合没有检测到代码文件变更</small>}
          </div>
        </div>
        {state.cancellationNote && <p className="hud-cancellation-note">这是协作式停止：正在进行的模型 HTTP 请求或 shell 子进程会等当前操作返回后退出，不会被强制杀死</p>}
      </section>
    );
  }

  return (
    <section className={`task-hud phase-${state.phase}`} aria-label="智能任务追踪与代码变更面板">
      <div className="hud-bar">
        <span className="hud-phase-icon" aria-hidden="true">{phaseIcon(state.phase)}</span>
        <div
          className="hud-hover-anchor hud-step-anchor"
          onMouseEnter={() => setStepsOpen(true)}
          onMouseLeave={() => setStepsOpen(false)}
          onFocus={() => setStepsOpen(true)}
          onBlur={() => setStepsOpen(false)}
        >
          <button className="hud-summary-button" type="button" onClick={() => setStepsOpen((value) => !value)}>
            <span className="hud-step-value" key={`${displayCurrentStep}/${displayTotalSteps}`}>
              {displayTotalSteps > 0 ? `第 ${displayCurrentStep}/${displayTotalSteps} 步` : "步骤待拆解"}
            </span>
          </button>
          {stepsOpen && state.steps.length > 0 && (
            <div className="hud-popover hud-steps-popover">
              {state.steps.map((step) => (
                <div className="hud-step-row" key={step.id}>
                  <span className={`hud-step-status status-${step.status}`}>{statusIcon(step.status)}</span>
                  <span>{step.title}</span>
                  <small>{stepStatusLabel(step.status)}</small>
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="hud-separator">·</span>
        <div
          className="hud-hover-anchor hud-files-anchor"
          onMouseEnter={() => setFilesOpen(true)}
          onMouseLeave={() => setFilesOpen(false)}
          onFocus={() => setFilesOpen(true)}
          onBlur={() => setFilesOpen(false)}
        >
          <button className="hud-summary-button" type="button" onClick={() => void onReview()}>
            {state.summary?.totalFiles ?? 0} 个文件已更改
          </button>
          {state.summary && (
            <span className="hud-diff-totals">
              <b className="hud-additions">+{state.summary.totalAdditions}</b>
              <b className="hud-deletions">-{state.summary.totalDeletions}</b>
            </span>
          )}
          {filesOpen && state.fileChanges.length > 0 && (
            <div className="hud-popover hud-files-popover">
              {state.fileChanges.map((file) => (
                <button
                  className={`hud-file-row ${selectedPath === file.path ? "selected" : ""}`}
                  type="button"
                  key={file.path}
                  onClick={() => {
                    setSelectedPath(file.path);
                    setDetailsOpen(true);
                  }}
                >
                  <span title={file.path}>{file.path}</span>
                  <small><b className="hud-additions">+{file.additions}</b> <b className="hud-deletions">-{file.deletions}</b></small>
                </button>
              ))}
            </div>
          )}
        </div>
        {state.operations.length > 0 && <span className="hud-operation-count">{state.operations.length} 个操作</span>}
        <button
          className={`hud-details-toggle ${detailsOpen ? "expanded" : ""}`}
          type="button"
          aria-expanded={detailsOpen}
          title={detailsOpen ? "折叠任务详情" : "展开任务详情"}
          onClick={() => setDetailsOpen((value) => !value)}
        >
          <ChevronDown size={14} />
        </button>
      </div>

      {detailsOpen && selectedFile && (
        <div className="hud-diff-preview">
          <div className="hud-diff-preview-heading">
            <FileCode2 size={13} />
            <strong>{selectedFile.path}</strong>
            <button className="hud-close-button" type="button" title="关闭预览" onClick={() => setSelectedPath(null)}>×</button>
          </div>
          <DiffPreview file={selectedFile} />
        </div>
      )}

      {detailsOpen && state.summary && (
        <div className="hud-completion-panel">
          <div className="hud-completion-heading">
            <div>
              <strong>{state.phase === "cancelled" ? "已请求停止" : state.phase === "failed" ? "任务未完成" : `已编辑 ${state.summary.totalFiles} 个文件`}</strong>
              <span><b className="hud-additions">+{state.summary.totalAdditions}</b> <b className="hud-deletions">-{state.summary.totalDeletions}</b></span>
            </div>
            <div className="hud-completion-actions">
              <button className="hud-action-button" type="button" title="撤销本会话新增变更" onClick={() => void onRevert()}>
                <RotateCcw size={13} /> 撤销
              </button>
              <button className="hud-action-button" type="button" title="创建 Code Review 请求" onClick={() => void onReview()}>
                <ClipboardCheck size={13} /> 审核
              </button>
              <button className="hud-close-button" type="button" title="折叠总结" onClick={() => setDetailsOpen(false)}><ChevronDown size={14} /></button>
            </div>
          </div>
          <div className={`hud-completion-files ${showAllFiles ? "is-expanded" : ""}`}>
            {visibleFiles.map((file) => (
              <button className="hud-completion-file" type="button" key={file.path} onClick={() => setSelectedPath(file.path)}>
                <span title={file.path}>{file.path}</span>
                <small><b className="hud-additions">+{file.additions}</b> <b className="hud-deletions">-{file.deletions}</b></small>
              </button>
            ))}
            {remainingFiles > 0 && (
              <button className="hud-more-files" type="button" onClick={() => setShowAllFiles((value) => !value)}>
                {showAllFiles ? "收起文件" : `再显示 ${remainingFiles} 个文件`}
              </button>
            )}
          </div>
          {state.cancellationNote && <p className="hud-cancellation-note">这是协作式停止：正在进行的模型 HTTP 请求或 shell 子进程会等当前操作返回后退出，不会被强制杀死</p>}
        </div>
      )}
    </section>
  );
}
