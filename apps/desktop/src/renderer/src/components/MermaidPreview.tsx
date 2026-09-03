import { useEffect, useId, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { CopyButton } from "./CopyButton";

export function MermaidPreview({ source }: { source: string }) {
  const reactId = useId().replaceAll(":", "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setSvg(null);
    setError(null);

    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
        return mermaid.render(`mermaid-preview-${reactId}`, source);
      })
      .then((result) => {
        if (!disposed) setSvg(result.svg);
      })
      .catch((renderError: unknown) => {
        if (!disposed) setError(renderError instanceof Error ? renderError.message : "图表无法渲染");
      });

    return () => {
      disposed = true;
    };
  }, [reactId, source]);

  return (
    <div className="mermaid-preview">
      <section className="mermaid-block">
        <header className="markdown-code-header">
          <span>渲染结果</span>
        </header>
        {svg ? (
          <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : error ? (
          <div className="mermaid-error">Mermaid 渲染失败：{error}</div>
        ) : (
          <p className="mermaid-loading"><LoaderCircle className="spin" size={16} /> 正在渲染 Mermaid 图表...</p>
        )}
      </section>
      <section className="mermaid-block">
        <header className="markdown-code-header">
          <span>源码</span>
          <CopyButton text={source} label="复制 Mermaid 源码" className="code-copy-button" />
        </header>
        <pre><code>{source}</code></pre>
      </section>
    </div>
  );
}
