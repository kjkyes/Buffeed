import { useEffect, useMemo, useState, type CSSProperties } from "react";
import DOMPurify from "dompurify";
import { Code2, ListTree, LoaderCircle } from "lucide-react";
import { load as loadYaml } from "js-yaml";

import { MarkdownContent } from "./MarkdownContent";
import { MermaidPreview } from "./MermaidPreview";

// pdfjs-dist 6 uses the upcoming Map getOrInsertComputed proposal, while the
// Chromium runtime bundled with Electron may not expose it yet.
const mapPrototype = Map.prototype as Map<unknown, unknown> & {
  getOrInsertComputed?: (key: unknown, callback: () => unknown) => unknown;
};
if (!mapPrototype.getOrInsertComputed) {
  Object.defineProperty(mapPrototype, "getOrInsertComputed", {
    configurable: true,
    value(this: Map<unknown, unknown>, key: unknown, callback: () => unknown) {
      if (!this.has(key)) this.set(key, callback());
      return this.get(key);
    },
  });
}

let pdfWorker: Worker | null = null;

function ensurePdfWorker(globalWorkerOptions: { workerPort: Worker | null }): void {
  if (globalWorkerOptions.workerPort) return;
  if (!pdfWorker) {
    pdfWorker = new Worker(new URL("../workers/pdfjs-worker.ts", import.meta.url), { type: "module" });
  }
  globalWorkerOptions.workerPort = pdfWorker;
}

export type PreviewFile = {
  path: string;
  name: string;
  extension: string;
  kind: "markdown" | "mermaid" | "text" | "json" | "yaml" | "image" | "video" | "pdf" | "doc" | "docx" | "presentation" | "spreadsheet";
  mimeType: string;
  content: string;
  pages?: string[];
};

function base64ToArrayBuffer(content: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function BinaryImagePreview({ file }: { file: PreviewFile }) {
  return <img className="image-preview" src={`data:${file.mimeType};base64,${file.content}`} alt={file.name} />;
}

function VideoPreview({ file }: { file: PreviewFile }) {
  const [error, setError] = useState(false);
  useEffect(() => setError(false), [file.content, file.mimeType]);
  if (error) {
    return <p className="preview-error">当前视频编码无法由 Chromium 解码。若已安装 ffmpeg，请完全退出并重启 Desktop，或设置 DESKTOP_FFMPEG 指向 ffmpeg.exe 后重试；也可以点击右上角“打开”使用系统播放器查看。</p>;
  }
  return (
    <section className="video-preview">
      <video className="video-player" controls preload="metadata" onError={() => setError(true)}>
        <source src={`data:${file.mimeType};base64,${file.content}`} type={file.mimeType} />
        当前 Electron 内核不支持此视频格式，请点击右上角“打开”使用系统播放器查看。
      </video>
    </section>
  );
}

function PdfPreview({ content }: { content: string }) {
  const [pages, setPages] = useState<string[]>([]);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: { promise: Promise<any>; destroy: () => Promise<void> } | null = null;
    setPages([]);
    setPageCount(null);
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const { GlobalWorkerOptions, getDocument } = await import("pdfjs-dist");
        ensurePdfWorker(GlobalWorkerOptions);
        loadingTask = getDocument({ data: new Uint8Array(base64ToArrayBuffer(content)) });
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        const pdfDocument = await loadingTask.promise;
        if (cancelled) return;
        setPageCount(pdfDocument.numPages);
        const renderedPages: string[] = [];
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          const page = await pdfDocument.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("浏览器不支持 PDF 画布渲染");
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          renderedPages.push(canvas.toDataURL("image/png"));
          if (!cancelled) setPages([...renderedPages]);
        }
        if (!cancelled) setLoading(false);
      } catch (loadError: unknown) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "PDF 无法加载");
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [content]);

  if (error) return <p className="preview-error">{error}</p>;
  return (
    <section className="pdf-preview">
      <header className="preview-toolbar">
        <span>{pageCount ? `${pageCount} 页` : "加载页数"}</span>
      </header>
      <div className="pdf-canvas-wrap">
        {loading ? <LoaderCircle className="preview-spinner" size={22} /> : null}
        {pages.map((page, index) => (
          <img key={index} className="pdf-page-image" src={page} alt={`第 ${index + 1} 页`} />
        ))}
      </div>
    </section>
  );
}

function DocxPreview({ content }: { content: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    void import("mammoth")
      .then(({ convertToHtml }) => convertToHtml({ arrayBuffer: base64ToArrayBuffer(content) }))
      .then((result) => {
        if (!cancelled) setHtml(DOMPurify.sanitize(result.value));
      })
      .catch((convertError: unknown) => {
        if (!cancelled) setError(convertError instanceof Error ? convertError.message : "DOCX 无法转换为预览内容");
      });
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (error) return <p className="preview-error">{error}</p>;
  if (!html) return <p className="preview-loading"><LoaderCircle className="spin" size={16} /> 正在读取 Word 文档...</p>;
  return <article className="docx-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function SpreadsheetPreview({ content }: { content: string }) {
  const [sheets, setSheets] = useState<Array<{ name: string; rows: unknown[][] }>>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets([]);
    setActiveSheet(0);
    setError(null);
    void import("xlsx")
      .then((XLSX) => {
        const workbook = XLSX.read(base64ToArrayBuffer(content), { type: "array", cellDates: true });
        return workbook.SheetNames.map((name) => ({
          name,
          rows: (XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false }) as unknown[][])
            .slice(0, 200)
            .map((row) => row.slice(0, 50)),
        }));
      })
      .then((nextSheets) => {
        if (!cancelled) setSheets(nextSheets);
      })
      .catch((parseError: unknown) => {
        if (!cancelled) setError(parseError instanceof Error ? parseError.message : "表格无法读取");
      });
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (error) return <p className="preview-error">{error}</p>;
  if (!sheets.length) return <p className="preview-loading"><LoaderCircle className="spin" size={16} /> 正在读取工作表...</p>;
  const sheet = sheets[activeSheet];
  const columnCount = Math.max(1, ...sheet.rows.map((row) => row.length));
  return (
    <section className="spreadsheet-preview">
      <nav className="sheet-tabs" aria-label="工作表">
        {sheets.map((item, index) => <button className={index === activeSheet ? "is-active" : ""} type="button" key={item.name} onClick={() => setActiveSheet(index)}>{item.name}</button>)}
      </nav>
      <div className="sheet-grid-wrap">
        <table className="sheet-grid">
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th scope="row">{rowIndex + 1}</th>
                {Array.from({ length: columnCount }, (_value, columnIndex) => <td key={columnIndex}>{String(row[columnIndex] ?? "")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="preview-limit-note">每个工作表最多显示 200 行、50 列。</p>
    </section>
  );
}

function PresentationPreview({ pages }: { pages?: string[] }) {
  if (!pages?.length) return <p className="preview-error">PPT/PPTX 页面截图不可用</p>;
  return (
    <section className="presentation-preview">
      <header className="preview-toolbar"><span>{pages.length} 页</span></header>
      <div className="presentation-pages">
        {pages.map((page, index) => <img key={index} className="presentation-page-image" src={page} alt={`第 ${index + 1} 页`} loading="lazy" decoding="async" />)}
      </div>
    </section>
  );
}

function StructuredValue({ name, value, depth = 0 }: { name?: string; value: unknown; depth?: number }) {
  if (value === null || typeof value !== "object") {
    const displayValue = typeof value === "string" ? JSON.stringify(value) : String(value);
    return <div className="structured-row" style={{ "--tree-depth": depth } as CSSProperties}><span>{name ? `${name}: ` : ""}</span><code>{displayValue}</code></div>;
  }
  if (depth >= 8) {
    return <div className="structured-row" style={{ "--tree-depth": depth } as CSSProperties}>嵌套层级已折叠</div>;
  }
  const allEntries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  const entries = allEntries.slice(0, 100);
  return (
    <section className="structured-branch" style={{ "--tree-depth": depth } as CSSProperties}>
      {name ? <strong>{name}{Array.isArray(value) ? " []" : " {}"}</strong> : null}
      {entries.map(([entryName, entryValue]) => <StructuredValue key={entryName} name={entryName} value={entryValue} depth={depth + 1} />)}
      {allEntries.length > entries.length ? <div className="structured-row">已省略 {allEntries.length - entries.length} 项</div> : null}
    </section>
  );
}

function StructuredPreview({ file }: { file: PreviewFile }) {
  const [mode, setMode] = useState<"tree" | "source">("tree");
  const parsed = useMemo(() => {
    try {
      return { value: file.kind === "json" ? JSON.parse(file.content) : loadYaml(file.content), error: null };
    } catch (error: unknown) {
      return { value: null, error: error instanceof Error ? error.message : "无法解析文件" };
    }
  }, [file]);

  if (parsed.error) return <p className="preview-error">{parsed.error}</p>;
  return (
    <section className="structured-preview">
      <header className="preview-toolbar structured-toolbar">
        <div className="preview-segmented-control" aria-label="预览模式">
          <button className={mode === "tree" ? "is-active" : ""} type="button" onClick={() => setMode("tree")}><ListTree size={14} />结构</button>
          <button className={mode === "source" ? "is-active" : ""} type="button" onClick={() => setMode("source")}><Code2 size={14} />源码</button>
        </div>
      </header>
      {mode === "tree" ? <div className="structured-tree"><StructuredValue value={parsed.value} /></div> : <pre className="standalone-source"><code>{file.content}</code></pre>}
    </section>
  );
}

export function FilePreviewContent({ file }: { file: PreviewFile }) {
  if (file.kind === "markdown") return <MarkdownContent text={file.content} />;
  if (file.kind === "mermaid") return <MermaidPreview source={file.content} />;
  if (file.kind === "image") return <BinaryImagePreview file={file} />;
  if (file.kind === "video") return <VideoPreview file={file} />;
  if (file.kind === "pdf") return <PdfPreview content={file.content} />;
  if (file.kind === "doc") return <pre className="standalone-source"><code>{file.content}</code></pre>;
  if (file.kind === "docx") return <DocxPreview content={file.content} />;
  if (file.kind === "presentation") return <PresentationPreview pages={file.pages} />;
  if (file.kind === "spreadsheet") return <SpreadsheetPreview content={file.content} />;
  if (file.kind === "json" || file.kind === "yaml") return <StructuredPreview file={file} />;
  return <pre className="standalone-source"><code>{file.content}</code></pre>;
}
