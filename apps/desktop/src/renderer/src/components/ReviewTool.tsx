import { ClipboardCheck, FileCode2, GitBranch, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { HUDFileChange } from "../domains/hud";

type ReviewToolProps = {
  workspace?: string;
  files: HUDFileChange[];
  turnId?: string | null;
  selectedPath?: string | null;
};

function DiffLines({ file }: { file: HUDFileChange }) {
  const lines = file.diffLines ?? [];
  if (!lines.length) {
    return <p className="review-empty">仅检测到改动位置：{file.hunks.map((hunk) => `${hunk.startLine}-${hunk.endLine}`).join(", ") || "暂无行号"}</p>;
  }
  return (
    <div className="review-diff-lines" role="region" aria-label={`${file.path} 改动代码`}>
      {lines.map((line, index) => {
        const number = line.kind === "deletion" ? line.oldLine : line.newLine ?? line.oldLine;
        const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
        return <div className={`review-diff-line kind-${line.kind}`} key={`${line.kind}-${number ?? "x"}-${index}`}><span>{number ?? ""}</span><code><b>{marker}</b>{line.text || " "}</code></div>;
      })}
    </div>
  );
}

export function ReviewTool({ workspace, files, turnId, selectedPath: requestedPath }: ReviewToolProps) {
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [metadataVisible, setMetadataVisible] = useState(true);
  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? files.filter((file) => file.path.toLowerCase().includes(normalized)) : files;
  }, [files, query]);
  const selectedFile = filteredFiles.find((file) => file.path === selectedPath) ?? filteredFiles[0] ?? null;

  useEffect(() => {
    setSelectedPath(requestedPath ?? null);
    setQuery("");
  }, [requestedPath, turnId]);

  return (
    <div className="review-tool">
      <header className="tool-header review-tool-header">
        <div><span className="eyebrow">工具插件</span><h2><ClipboardCheck size={16} /> 改动审核</h2></div>
        <button
          className="icon-button"
          type="button"
          title={metadataVisible ? "隐藏文件区" : "显示文件区"}
          aria-label={metadataVisible ? "隐藏文件区" : "显示文件区"}
          aria-pressed={metadataVisible}
          onClick={() => setMetadataVisible((visible) => !visible)}
        >
          {metadataVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </header>
      <div className={`review-tool-body ${metadataVisible ? "" : "is-sidebar-hidden"}`}>
        <section className="review-code-panel" aria-label="改动代码">
          {selectedFile ? <><div className="review-file-heading"><FileCode2 size={14} /><strong title={selectedFile.path}>{selectedFile.path}</strong><span><b className="hud-additions">+{selectedFile.additions}</b> <b className="hud-deletions">-{selectedFile.deletions}</b></span></div><DiffLines file={selectedFile} /></> : <p className="review-empty">该回合没有可展示的文件改动</p>}
        </section>
        {metadataVisible && <aside className="review-file-panel" aria-label="改动文件筛选">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选文件..." aria-label="筛选改动文件" />
          <div className="review-file-list">
            {filteredFiles.map((file) => <button className={file.path === selectedFile?.path ? "is-active" : ""} type="button" key={file.path} onClick={() => setSelectedPath(file.path)}><span title={file.path}>{file.path}</span><small><b className="hud-additions">+{file.additions}</b> <b className="hud-deletions">-{file.deletions}</b></small></button>)}
            {!filteredFiles.length && <p className="review-empty">没有匹配文件</p>}
          </div>
          <div className="review-file-count">{files.length} 个文件</div>
        </aside>}
      </div>
      {metadataVisible && <footer className="review-worktree"><GitBranch size={14} /><span>worktree</span><code title={workspace || "未选择工作区"}>{workspace || "未选择工作区"}</code></footer>}
    </div>
  );
}
