import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import "katex/dist/katex.min.css";

import { CopyButton } from "./CopyButton";
import { MermaidPreview } from "./MermaidPreview";

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <section className="markdown-code-block">
      <header className="markdown-code-header">
        <span>{language || "text"}</span>
        <CopyButton text={code} label="复制代码" className="code-copy-button" />
      </header>
      <pre><code className={language ? `language-${language}` : undefined}>{code}</code></pre>
    </section>
  );
}

export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children, node: _node, ...props }) {
            const code = String(children).replace(/\n$/, "");
            const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
            const isBlock = Boolean(className)
              || Boolean(
                _node?.position
                && _node.position.start.line !== _node.position.end.line,
              );
            if (language === "mermaid") {
              return <MermaidPreview source={code} />;
            }
            if (isBlock) {
              return <CodeBlock code={code} language={language} />;
            }
            return <code className="markdown-inline-code" {...props}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
