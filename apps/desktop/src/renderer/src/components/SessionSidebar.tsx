import { ChevronRight, FolderOpen, Settings, Sparkles } from "lucide-react";

import type { Session } from "../domains/agent";
import { timeLabel } from "../utils/format";

type SessionSidebarProps = {
  workspace: string;
  sessions: Session[];
  activeSessionId: string | null;
  statusMessage: string;
  onWorkspaceChange: (workspace: string) => void;
  onNewConversation: () => void;
  onSelectSession: (session: Session) => void | Promise<void>;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
};

export function SessionSidebar({
  workspace,
  sessions,
  activeSessionId,
  statusMessage,
  onWorkspaceChange,
  onNewConversation,
  onSelectSession,
  onOpenSettings,
  onOpenPlugins,
}: SessionSidebarProps) {
  const projects = new Map<string, Session[]>();
  for (const session of sessions) {
    const group = projects.get(session.workspace) ?? [];
    group.push(session);
    projects.set(session.workspace, group);
  }
  const projectGroups = [...projects.entries()].sort(
    ([, left], [, right]) => (right[0]?.updated_at ?? 0) - (left[0]?.updated_at ?? 0),
  );

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <strong>Buffeed</strong>
      </div>

      <section className="workspace-control" aria-label="新对话">
        <button className="primary-button new-session-button" onClick={onNewConversation}>
          <ChevronRight size={16} /> 新对话
        </button>
      </section>

      <button className="sidebar-plugin-button" type="button" onClick={onOpenPlugins}><Sparkles size={15} /> 插件</button>

      <nav className="session-list" aria-label="会话列表">
        <div className="section-label">会话</div>
        {sessions.length === 0 && <p className="empty-copy">没有会话</p>}
        {projectGroups.map(([projectPath, projectSessions]) => {
          const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
          return (
            <section className="project-session-group" key={projectPath}>
              <div className="project-session-heading" title={projectPath}>
                <FolderOpen size={14} />
                <span>{projectName}</span>
                <small>{projectSessions.length}</small>
              </div>
              {projectSessions.map((session) => (
                <button
                  key={session.session_id}
                  className={`session-item ${session.session_id === activeSessionId ? "selected" : ""}`}
                  onClick={() => void onSelectSession(session)}
                >
                  <span className={`status-dot ${session.status}`} />
                  <span>
                    <strong title={session.session_id}>{session.title || session.session_id.slice(0, 8)}</strong>
                    <small>{timeLabel(session.updated_at)}</small>
                  </span>
                </button>
              ))}
            </section>
          );
        })}
      </nav>

      <footer className="sidebar-footer">
        <div className="sidebar-status" title={activeSessionId ? statusMessage : "请点击或创建会话"}>
          {activeSessionId ? statusMessage : "请点击或创建会话"}
        </div>
        <button className="sidebar-settings-button" type="button" onClick={onOpenSettings}>
          <Settings size={14} /> 设置
        </button>
      </footer>
    </aside>
  );
}
