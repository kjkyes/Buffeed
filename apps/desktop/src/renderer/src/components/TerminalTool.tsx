import { useEffect, useRef, useState } from "react";
import { Plus, Square, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TerminalTab = { id: string; title: string };

function TerminalInstance({ workspace, active }: { workspace?: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pendingInputRef = useRef("");
  const initialWorkspaceRef = useRef(workspace);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const api = window.desktop?.terminal;
    if (!host || !api) return undefined;
    const configuredFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--code-font-size"));
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: Number.isFinite(configuredFontSize) ? configuredFontSize : 12,
      scrollback: 10_000,
      theme: { background: "#1b1d1e", foreground: "#d7e2df", cursor: "#6bd3b7", selectionBackground: "#35665a" },
    });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);
    const resize = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
      const id = sessionRef.current;
      if (id) void api.resize(id, terminal.cols, terminal.rows);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const inputDisposable = terminal.onData((data) => {
      const id = sessionRef.current;
      if (!id) pendingInputRef.current += data;
      else void api.write(id, data);
    });
    const offOutput = api.onOutput((event) => {
      if (event.id === sessionRef.current) terminal.write(event.data);
    });
    const offExit = api.onExit((event) => {
      if (event.id !== sessionRef.current) return;
      setSessionId(null);
      terminal.write(`\r\n\x1b[90m[进程已退出: ${event.code ?? event.signal}]\x1b[0m\r\n`);
    });
    let disposed = false;
    void api.create(initialWorkspaceRef.current).then(({ id }) => {
      if (disposed) {
        void api.close(id);
        return;
      }
      sessionRef.current = id;
      setSessionId(id);
      resize();
      if (pendingInputRef.current) {
        void api.write(id, pendingInputRef.current);
        pendingInputRef.current = "";
      }
    }).catch((error: unknown) => {
      terminal.write(`\r\n\x1b[31m终端启动失败: ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
    });
    return () => {
      disposed = true;
      inputDisposable.dispose();
      offOutput();
      offExit();
      observer.disconnect();
      const id = sessionRef.current;
      if (id) void api.close(id);
      sessionRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const host = hostRef.current;
      const fit = fitRef.current;
      const terminal = terminalRef.current;
      if (!host || !fit || !terminal || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      fit.fit();
      const id = sessionRef.current;
      if (id) void window.desktop?.terminal.resize(id, terminal.cols, terminal.rows);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, sessionId]);

  return <div className={`terminal-view ${active ? "is-active" : ""}`}><div ref={hostRef} className="terminal-host" aria-label="终端" /></div>;
}

export function TerminalTool({ workspace }: { workspace?: string }) {
  const nextTabNumberRef = useRef(2);
  const [tabs, setTabs] = useState<TerminalTab[]>([{ id: "terminal-1", title: "终端 1" }]);
  const [activeTabId, setActiveTabId] = useState<string | null>("terminal-1");
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const addTerminal = () => {
    const number = nextTabNumberRef.current;
    nextTabNumberRef.current += 1;
    const tab = { id: `terminal-${number}`, title: `终端 ${number}` };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  };

  const closeTerminal = (id: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
    setActiveTabId((current) => current === id ? null : current);
  };

  useEffect(() => {
    if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) return;
    setActiveTabId(tabs.at(-1)?.id ?? null);
  }, [activeTabId, tabs]);

  return (
    <div className="terminal-tool">
      <header className="tool-header">
        <div><span className="eyebrow">工具插件</span><h2><TerminalSquare size={16} /> 内置终端</h2></div>
        <button className="icon-button danger" type="button" title="关闭当前终端" aria-label="关闭当前终端" disabled={!activeTab} onClick={() => { if (activeTab) closeTerminal(activeTab.id); }}><Square size={15} /></button>
      </header>
      <nav className="terminal-tabs" aria-label="终端窗口">
        <div className="terminal-tab-list">
          {tabs.map((tab) => (
            <div className={`terminal-tab ${tab.id === activeTabId ? "is-active" : ""}`} key={tab.id}>
              <button className="terminal-tab-select" type="button" onClick={() => setActiveTabId(tab.id)}><TerminalSquare size={14} /><span>{tab.title}</span></button>
              <button className="terminal-tab-close" type="button" title={`关闭${tab.title}`} aria-label={`关闭${tab.title}`} onClick={() => closeTerminal(tab.id)}><X size={14} /></button>
            </div>
          ))}
        </div>
        <button className="terminal-tab-add" type="button" title="新建终端" aria-label="新建终端" onClick={addTerminal}><Plus size={16} /></button>
      </nav>
      <div className="terminal-views">
        {tabs.map((tab) => <TerminalInstance key={tab.id} workspace={workspace} active={tab.id === activeTabId} />)}
        {tabs.length === 0 && <div className="terminal-empty">暂无终端，点击上方加号新建</div>}
      </div>
    </div>
  );
}
