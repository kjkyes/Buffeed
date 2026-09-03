import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileText, FolderOpen, LoaderCircle, MonitorUp } from "lucide-react";

import { FilePreviewContent, type PreviewFile } from "./FilePreviewContent";

type EditorInfo = { id: string; name: string };

export function FilePreviewTool({ requestedPath }: { requestedPath?: string | null }) {
  const [file, setFile] = useState<PreviewFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [openMenuVisible, setOpenMenuVisible] = useState(false);
  const [opening, setOpening] = useState(false);
  const openTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!file) return;
    void window.desktop?.previewEditors().then(setEditors).catch(() => setEditors([]));
  }, [file]);

  useEffect(() => {
    if (!requestedPath) return;
    let cancelled = false;
    setFile(null);
    setEditors([]);
    setError(null);
    setLoading(true);
    void window.desktop?.previewAttachmentFile(requestedPath)
      .then((selected) => {
        if (!cancelled) setFile(selected);
      })
      .catch((fileError: unknown) => {
        if (!cancelled) setError(fileError instanceof Error ? fileError.message : "无法读取文件");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [requestedPath]);

  useEffect(() => {
    if (!openMenuVisible) return undefined;
    const handleOutsidePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".open-with-menu")) return;
      setOpenMenuVisible(false);
      window.requestAnimationFrame(() => openTriggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [openMenuVisible]);

  const openFile = async () => {
    setError(null);
    setLoading(true);
    try {
      const selected = await window.desktop?.selectPreviewFile();
      if (selected) setFile(selected);
    } catch (fileError: unknown) {
      setError(fileError instanceof Error ? fileError.message : "无法读取文件");
    } finally {
      setLoading(false);
    }
  };

  const openWith = async (editorId: string) => {
    if (!file) return;
    setError(null);
    setOpening(true);
    try {
      await window.desktop?.openPreviewFile(file.path, editorId);
      setOpenMenuVisible(false);
      window.requestAnimationFrame(() => openTriggerRef.current?.focus());
    } catch (openError: unknown) {
      setError(openError instanceof Error ? openError.message : "无法打开文件");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="file-tool">
      <header className="tool-header">
        <div>
          <span className="eyebrow">工具插件</span>
          <h2>{file?.name ?? "文件预览"}</h2>
        </div>
        <div className="file-header-actions">
          {file ? (
            <div className="open-with-menu">
              <button ref={openTriggerRef} className="secondary-button file-open-button" type="button" disabled={opening} onClick={() => setOpenMenuVisible((visible) => !visible)}>
                {opening ? <LoaderCircle className="spin" size={15} /> : <MonitorUp size={15} />}
                打开
                <ChevronDown size={14} />
              </button>
              {openMenuVisible ? (
                <div className="open-with-options" role="menu" aria-label="选择打开方式">
                  <button type="button" role="menuitem" onClick={() => void openWith("default")}>默认应用</button>
                  {editors.map((editor) => <button type="button" role="menuitem" key={editor.id} onClick={() => void openWith(editor.id)}>{editor.name}</button>)}
                </div>
              ) : null}
            </div>
          ) : null}
          <button className="secondary-button file-open-button" type="button" disabled={loading} onClick={() => void openFile()}>
            {loading ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
            选择文件
          </button>
        </div>
      </header>
      <div className="tool-error-slot">{error ? <p className="tool-error">{error}</p> : null}</div>
      {loading ? (
        <div className="file-preview-loading" role="status" aria-live="polite">
          <LoaderCircle className="spin" size={28} />
          <span>正在解析文件...</span>
        </div>
      ) : !file ? (
        <div className="tool-empty-state">
          <FileText size={28} strokeWidth={1.5} />
          <p>选择文件开始预览</p>
        </div>
      ) : (
        <div className="file-preview-content">
          <div className="file-meta"><span>{file.extension || "文本"}</span><small>{file.path}</small></div>
          <FilePreviewContent file={file} />
        </div>
      )}
    </div>
  );
}
