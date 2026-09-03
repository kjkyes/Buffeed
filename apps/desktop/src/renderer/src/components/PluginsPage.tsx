import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Github, Loader2, Plus, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import {
  getPluginInventory,
  installPlugin,
  uninstallPlugin,
  searchGitHubPlugins,
  type GitHubPluginResult,
  type PluginInventory,
} from "../services/agentApi";

export type PluginKind = "mcp" | "skills";

type PluginsPageProps = {
  agentApi: string;
  workspace: string;
  kind: PluginKind;
  onKindChange: (kind: PluginKind) => void;
  onWorkspaceChange?: (workspace: string) => void;
  onBack: () => void;
};

const EMPTY: PluginInventory = { mcp: [], skills: [] };

export function PluginsPage({ agentApi, workspace, kind, onKindChange, onWorkspaceChange, onBack }: PluginsPageProps) {
  const [inventory, setInventory] = useState<PluginInventory>(EMPTY);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GitHubPluginResult["items"]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [serverName, setServerName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse" | "streamable-http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState<string | null>(null);

  const refresh = async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      setInventory(await getPluginInventory(agentApi, workspace));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [agentApi, workspace]);

  const search = async () => {
    if (query.trim().length < 2) return;
    setLoading(true);
    setMessage("");
    try {
      const response = await searchGitHubPlugins(agentApi, query.trim(), kind);
      setResults(response.items);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const submitInstall = async () => {
    if (!workspace) { setMessage("请先选择一个工作区"); return; }
    if (!source.trim()) return;
    setInstalling(true);
    setMessage("");
    try {
      await installPlugin(agentApi, {
        workspace, kind, source: source.trim(), ref: ref.trim() || undefined,
        name: serverName.trim() || undefined, transport,
        command: command.trim() || undefined,
        args: args.split(" ").map((value) => value.trim()).filter(Boolean),
        url: url.trim() || undefined,
      });
      setMessage("插件已添加");
      setShowAdd(false);
      setSource("");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
    }
  };

  const submitUninstall = async (item: PluginInventory["mcp"][number]) => {
    if (!workspace || !item.removable || uninstalling) return;
    const itemId = item.id ?? item.name;
    setUninstalling(itemId);
    setMessage("");
    try {
      await uninstallPlugin(agentApi, { workspace, kind, name: itemId });
      setMessage("插件已卸载");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUninstalling(null);
    }
  };

  const installed = inventory[kind];
  return (
    <section className="plugins-page">
      <header className="plugins-header">
        <div className="plugins-title-row">
          <button className="icon-button" type="button" title="返回会话" aria-label="返回会话" onClick={onBack}><ArrowLeft size={17} /></button>
          <div><span className="eyebrow">工作区插件</span><h1>插件</h1></div>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" title="刷新插件" aria-label="刷新插件" onClick={() => void refresh()}><RefreshCw size={16} /></button>
          <button className="primary-button" type="button" onClick={() => setShowAdd(true)}><Plus size={15} /> 添加</button>
        </div>
      </header>
      <div className="plugins-body">
        <nav className="plugins-tabs" aria-label="插件类型">
          <button className={kind === "mcp" ? "selected" : ""} onClick={() => { onKindChange("mcp"); setResults([]); }}><Github size={15} /> MCP</button>
          <button className={kind === "skills" ? "selected" : ""} onClick={() => { onKindChange("skills"); setResults([]); }}><Sparkles size={15} /> Skills</button>
        </nav>
        <button className="plugin-workspace-button" type="button" onClick={async () => { const selected = await window.desktop?.selectWorkspace(); if (selected) onWorkspaceChange?.(selected); }}><span>选择工作区</span><strong>{workspace || "未选择工作区"}</strong></button>
        <div className="plugins-intro"><div><h2>{kind === "mcp" ? "MCP 工具" : "Skills 技能"}</h2><p>{kind === "mcp" ? "管理已接入 Agent 的外部工具服务" : "管理工作区可用的 Agent 技能"}</p></div><span className="plugin-count">{installed.length} 个已安装</span></div>
        <div className="plugin-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder={`搜索 Github ${kind === "mcp" ? "MCP" : "Skills"} 仓库`} /><button type="button" onClick={() => void search()} disabled={loading || query.trim().length < 2}>{loading ? <Loader2 className="spin" size={15} /> : "搜索"}</button></div>
        {!workspace && <div className="plugin-empty">选择工作区后即可配置插件。</div>}
        {message && <div className="plugin-message">{message}</div>}
        <div className="plugin-list">{installed.map((item) => { const itemId = item.id ?? item.name; return <article className="plugin-card" key={`${itemId}-${item.source ?? ""}`}><div className="plugin-card-icon">{kind === "mcp" ? <Github size={18} /> : <Sparkles size={18} />}</div><div className="plugin-card-content"><strong>{item.name}</strong><span>{kind === "mcp" ? `${item.transport} · ${item.endpoint || "本地配置"}` : (item.description || "工作区 Skill")}</span></div>{item.removable ? <button className="plugin-uninstall-button" type="button" title="卸载插件" aria-label={`卸载 ${item.name}`} disabled={uninstalling !== null} onClick={() => void submitUninstall(item)}><span>{uninstalling === itemId ? "卸载中" : "已安装"}</span><Trash2 size={15} /></button> : <><span className="plugin-status">{kind === "mcp" && item.status === "connected" ? "已连接" : "已安装"}</span><CheckCircle2 className="plugin-installed" size={16} /></>}</article>; })}</div>
        {results.length > 0 && <div className="plugin-results"><h3>Github 搜索结果</h3>{results.map((item) => <article className="plugin-card" key={item.full_name}><div className="plugin-card-icon"><Github size={18} /></div><div className="plugin-card-content"><strong>{item.full_name}</strong><span>{item.description || "暂无描述"} · ★ {item.stars}</span></div><button className="secondary-button plugin-install-button" type="button" onClick={() => { setSource(item.full_name); setRef(item.default_branch); setShowAdd(true); }}>添加</button></article>)}</div>}
      </div>
      {showAdd && <div className="plugin-modal-backdrop" role="presentation"><div className="plugin-modal" role="dialog" aria-modal="true" aria-label="添加插件"><header><div><span className="eyebrow">Github 仓库</span><h2>添加 {kind === "mcp" ? "MCP" : "Skill"}</h2></div><button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={() => setShowAdd(false)}><X size={17} /></button></header><label>仓库地址<input value={source} onChange={(event) => setSource(event.target.value)} placeholder="owner/repo 或 https://github.com/owner/repo" /></label><label>Git ref<input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" /></label>{kind === "mcp" && <><label>服务名称<input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder="自动使用仓库名" /></label><label>传输方式<select value={transport} onChange={(event) => setTransport(event.target.value as typeof transport)}><option value="stdio">stdio（本地进程）</option><option value="streamable-http">streamable-http</option><option value="sse">SSE</option></select></label>{transport === "stdio" ? <><label>启动命令<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></label><label>参数（空格分隔）<input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem" /></label></> : <label>服务 URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></label>}</>}<footer><button className="secondary-button" type="button" onClick={() => setShowAdd(false)}>取消</button><button className="primary-button" type="button" disabled={installing || !source.trim()} onClick={() => void submitInstall()}>{installing ? <Loader2 className="spin" size={15} /> : <Plus size={15} />} 添加插件</button></footer></div></div>}
    </section>
  );
}

export function PluginsSidebar({ kind, onKindChange, onBack }: { kind: PluginKind; onKindChange: (kind: PluginKind) => void; onBack: () => void }) {
  return <aside className="sidebar plugins-sidebar"><div className="brand-row"><strong>Buffeed</strong></div><button className="sidebar-settings-button" type="button" onClick={onBack}><ArrowLeft size={15} /> 返回会话</button><div className="section-label">插件</div><nav className="plugin-side-nav"><button className={kind === "mcp" ? "selected" : ""} onClick={() => onKindChange("mcp")}><Github size={15} /> MCP</button><button className={kind === "skills" ? "selected" : ""} onClick={() => onKindChange("skills")}><Sparkles size={15} /> Skills</button></nav></aside>;
}
