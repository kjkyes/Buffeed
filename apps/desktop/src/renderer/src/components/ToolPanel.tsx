import { useEffect, useState } from "react";
import { ClipboardCheck, FileText, Globe, Network, TerminalSquare } from "lucide-react";

import { BrowserTool } from "./BrowserTool";
import { FilePreviewTool } from "./FilePreviewTool";
import { TerminalTool } from "./TerminalTool";
import { TeamObservationPanel } from "./TeamObservationPanel";
import type { TeamObservation } from "../domains/team";
import type { HUDFileChange } from "../domains/hud";
import { ReviewTool } from "./ReviewTool";

type ToolId = "browser" | "file" | "terminal" | "team" | "review";

export function ToolPanel({ workspace, teamObservation, teamObservationError, previewFilePath, reviewFiles = [], reviewTurnId, reviewFilePath }: { workspace?: string; teamObservation: TeamObservation | null; teamObservationError: string | null; previewFilePath?: string | null; reviewFiles?: HUDFileChange[]; reviewTurnId?: string | null; reviewFilePath?: string | null }) {
  const [activeTool, setActiveTool] = useState<ToolId>("browser");
  const [terminalOpened, setTerminalOpened] = useState(false);
  useEffect(() => { if (teamObservation?.available) setActiveTool("team"); }, [teamObservation?.available, teamObservation?.execution_id]);
  useEffect(() => { if (previewFilePath) setActiveTool("file"); }, [previewFilePath]);
  useEffect(() => { if (reviewTurnId || reviewFilePath) setActiveTool("review"); }, [reviewFilePath, reviewTurnId]);

  return (
    <div className="tool-panel-inner">
      <nav className="tool-rail" aria-label="工具插件">
        <button
          className={`tool-rail-button ${activeTool === "browser" ? "is-active" : ""}`}
          type="button"
          aria-label="浏览器"
          title="浏览器"
          onClick={() => setActiveTool("browser")}
        >
          <Globe size={16} />
        </button>
        <button className={`tool-rail-button ${activeTool === "review" ? "is-active" : ""}`} type="button" aria-label="改动审核" title="改动审核" onClick={() => setActiveTool("review")}><ClipboardCheck size={16} /></button>
        <button className={`tool-rail-button ${activeTool === "team" ? "is-active" : ""}`} type="button" aria-label="协作观测" title="协作观测" onClick={() => setActiveTool("team")}><Network size={16} /></button>
        <button
          className={`tool-rail-button ${activeTool === "terminal" ? "is-active" : ""}`}
          type="button"
          aria-label="终端"
          title="终端"
          onClick={() => { setTerminalOpened(true); setActiveTool("terminal"); }}
        >
          <TerminalSquare size={16} />
        </button>
        <button
          className={`tool-rail-button ${activeTool === "file" ? "is-active" : ""}`}
          type="button"
          aria-label="文件预览"
          title="文件预览"
          onClick={() => setActiveTool("file")}
        >
          <FileText size={16} />
        </button>
      </nav>
      <section className="tool-surface">
        <div className="tool-view-stack">
          <div className={`tool-view ${activeTool === "browser" ? "is-active" : ""}`}>
            {activeTool === "browser" && <BrowserTool workspace={workspace} />}
          </div>
          <div className={`tool-view ${activeTool === "team" ? "is-active" : ""}`}>
            {activeTool === "team" && <TeamObservationPanel observation={teamObservation} error={teamObservationError} />}
          </div>
          <div className={`tool-view ${activeTool === "review" ? "is-active" : ""}`}>
            {activeTool === "review" && <ReviewTool workspace={workspace} files={reviewFiles} turnId={reviewTurnId} selectedPath={reviewFilePath} />}
          </div>
          <div className={`tool-view ${activeTool === "file" ? "is-active" : ""}`}>
            {activeTool === "file" && <FilePreviewTool requestedPath={previewFilePath} />}
          </div>
          {terminalOpened && <div className={`tool-view ${activeTool === "terminal" ? "is-active" : ""}`}><TerminalTool workspace={workspace} /></div>}
        </div>
      </section>
    </div>
  );
}
