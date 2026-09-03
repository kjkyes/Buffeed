import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

type CopyButtonProps = { text: string; label: string; className?: string };

async function copyText(text: string): Promise<void> {
  if (window.desktop?.writeClipboardText) {
    await window.desktop.writeClipboardText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败");
}

export function CopyButton({ text, label, className = "copy-button" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await copyText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      className={className}
      type="button"
      title={copied ? "已复制" : label}
      aria-label={copied ? "已复制" : label}
      onClick={() => void handleCopy()}
      disabled={!text}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
