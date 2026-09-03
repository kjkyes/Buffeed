import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Copy, ExternalLink, LoaderCircle, Play, Plus, RefreshCw, X } from "lucide-react";

type BrowserTab = { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };
type BrowserState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; tabs: BrowserTab[]; activeTabId: string | null };
const TITLE_BAR_OVERLAY_HEIGHT = -18;
const BASE_LAYOUT_SCALE = 1.2;
const BASE_BROWSER_HORIZONTAL_SCALE = 1.09;
const initialState: BrowserState = { url: "", title: "新标签页", loading: false, canGoBack: false, canGoForward: false, tabs: [], activeTabId: null };

export function BrowserTool({ workspace }: { workspace?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState("");
  const [state, setState] = useState(initialState);
  const [editingAddress, setEditingAddress] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [devServers, setDevServers] = useState<Array<{ id: string; label: string; command: string; cwd: string; url: string }>>([]);
  const [download, setDownload] = useState<string | null>(null);

  useEffect(() => {
    const browser = window.desktop?.browser;
    if (!browser) return undefined;
    void browser.tabs().then((next) => {
      setState(next);
      setAddress(next.url);
      setEditingAddress(!next.url);
    }).catch(() => undefined);
    return browser.onState((next) => {
      setState(next);
      if (next.url) {
        setAddress(next.url);
        setEditingAddress(false);
      }
    });
  }, []);

  useEffect(() => {
    if (editingAddress) requestAnimationFrame(() => addressInputRef.current?.focus());
  }, [editingAddress]);

  useEffect(() => {
    if (!editingAddress) return undefined;
    const cancelOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".browser-tab.is-editing")) return;
      setAddress(state.url);
      setEditingAddress(false);
    };
    document.addEventListener("pointerdown", cancelOnOutsideClick);
    return () => document.removeEventListener("pointerdown", cancelOnOutsideClick);
  }, [editingAddress, state.url]);

  useEffect(() => {
    if (workspace) void window.desktop?.devServers(workspace).then(setDevServers).catch(() => setDevServers([]));
  }, [workspace]);

  useEffect(() => window.desktop?.browser.onDownload((event) => setDownload(`${event.name} · ${event.status === "completed" ? "已下载" : event.status}`)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "l") { event.preventDefault(); setEditingAddress(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".browser-address input")?.focus()); }
      if (event.key.toLowerCase() === "t") { event.preventDefault(); setAddress(""); setEditingAddress(true); void window.desktop?.browser.newTab(); }
      if (event.key.toLowerCase() === "w") { event.preventDefault(); void window.desktop?.browser.closeTab(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const browser = window.desktop?.browser;
    if (!host || !browser) return undefined;
    void browser.attach();
    const syncBounds = () => {
      const rect = host.getBoundingClientRect();
      const layoutScale = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--layout-scale"),
      ) || 1;
      const horizontalScale = (layoutScale / BASE_LAYOUT_SCALE) * BASE_BROWSER_HORIZONTAL_SCALE;
      browser.setBounds({
        // The workbench dimensions are authored in scaled CSS units while
        // WebContentsView bounds are unscaled window DIP units.
        x: Math.max(0, rect.left / horizontalScale),
        y: Math.max(0, rect.top / layoutScale - TITLE_BAR_OVERLAY_HEIGHT),
        width: rect.width / horizontalScale,
        // getBoundingClientRect() already returns CSS pixels matching the
        // WebContentsView DIP coordinate space; layoutScale only sizes the UI.
        height: rect.height,
      });
    };
    let syncFrame: number | undefined;
    const scheduleSyncBounds = () => {
      if (syncFrame !== undefined) return;
      syncFrame = window.requestAnimationFrame(() => {
        syncFrame = undefined;
        syncBounds();
      });
    };
    const observer = new ResizeObserver(scheduleSyncBounds);
    observer.observe(host);
    const layoutRoot = host.closest<HTMLElement>(".workbench");
    const layoutObserver = layoutRoot ? new MutationObserver(scheduleSyncBounds) : undefined;
    layoutObserver?.observe(layoutRoot, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", scheduleSyncBounds);
    scheduleSyncBounds();
    return () => {
      observer.disconnect();
      layoutObserver?.disconnect();
      window.removeEventListener("resize", scheduleSyncBounds);
      if (syncFrame !== undefined) window.cancelAnimationFrame(syncFrame);
      void browser.detach();
    };
  }, []);

  const navigate = async () => {
    const value = address.trim();
    if (!value) return;
    setError(null);
    try {
      await window.desktop?.browser.navigate(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      setEditingAddress(false);
    } catch (navigationError: unknown) {
      setError(navigationError instanceof Error ? navigationError.message : "无法打开页面");
    }
  };

  return (
    <div className="browser-tool">
      <header className="tool-header"><div><span className="eyebrow">工具插件</span><h2>{state.title || "浏览器"}</h2></div><button className="icon-button" type="button" title="打开开发者工具" aria-label="打开开发者工具" onClick={() => void window.desktop?.browser.openDevTools()}><ExternalLink size={16} /></button></header>
      <div className="browser-toolbar">
        <div className="browser-tabs" role="tablist">
          {state.tabs.map((tab) => {
            const active = tab.id === state.activeTabId;
            const editing = active && editingAddress;
            return <div key={tab.id} className={`browser-tab ${active ? "is-active" : ""} ${editing ? "is-editing" : ""}`} role="tab" title={tab.url || "新标签页"} onClick={() => {
              if (active) { setAddress(tab.url); setEditingAddress(true); }
              else { setAddress(tab.url); setEditingAddress(false); void window.desktop?.browser.switchTab(tab.id); }
            }}>
              {editing ? <span className="browser-tab-editor"><input ref={active ? addressInputRef : undefined} value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void navigate(); } if (event.key === "Escape") { setAddress(tab.url); setEditingAddress(false); } }} aria-label="浏览器地址" /><button className="browser-tab-clear" type="button" aria-label="清除 URL" title="清除 URL" onClick={(event) => { event.stopPropagation(); setAddress(""); addressInputRef.current?.focus(); }}><X size={12} /></button></span> : <><span>{tab.title || "新标签页"}</span><button className="browser-tab-close" type="button" aria-label="关闭标签页" onClick={(event) => { event.stopPropagation(); void window.desktop?.browser.closeTab(tab.id); }}><X size={12} /></button></>}
            </div>;
          })}
          <button className="icon-button" type="button" title="新建标签页" aria-label="新建标签页" onClick={() => { setAddress(""); setEditingAddress(true); void window.desktop?.browser.newTab(); }}><Plus size={15} /></button>
          <button className="icon-button" type="button" title="复制当前标签" aria-label="复制当前标签" onClick={() => void window.desktop?.browser.duplicateTab()}><Copy size={14} /></button>
        </div>
        <div className="browser-controls">
          {!state.tabs.length && !state.url ? <form className="browser-address browser-address-empty" onSubmit={(event) => { event.preventDefault(); void navigate(); }}><input ref={addressInputRef} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="输入 URL" aria-label="浏览器地址" /></form> : null}
          <button className="icon-button" type="button" title="后退" aria-label="后退" disabled={!state.canGoBack} onClick={() => void window.desktop?.browser.back()}><ArrowLeft size={15} /></button>
          <button className="icon-button" type="button" title="前进" aria-label="前进" disabled={!state.canGoForward} onClick={() => void window.desktop?.browser.forward()}><ArrowRight size={15} /></button>
          <button className="icon-button" type="button" title="刷新" aria-label="刷新" onClick={() => void window.desktop?.browser.reload()}>{state.loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button>
        </div>
      </div>
      {devServers.length > 0 ? <div className="browser-dev-shortcuts"><span>项目预览</span>{devServers.map((server) => <button key={server.id} type="button" onClick={() => void window.desktop?.startDevServer(server).catch((startError) => setError(startError instanceof Error ? startError.message : "无法启动开发服务"))}><Play size={13} />{server.label}</button>)}</div> : null}
      <div className="tool-error-slot">{error ? <p className="tool-error">{error}</p> : null}</div>
      {download ? <p className="browser-download-note">{download}</p> : null}
      <div ref={hostRef} className="browser-view-host" aria-label="浏览器页面" />
    </div>
  );
}
