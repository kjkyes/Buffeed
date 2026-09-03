import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type CSSProperties } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

type AppShellProps = {
  sidebar: ReactNode;
  agentWorkspace: ReactNode;
  toolPanel: ReactNode;
  toolPanelVisible: boolean;
};

const SIDEBAR_WIDTH = 244;
const DIVIDER_WIDTH = 8;
const MIN_CONVERSATION_WIDTH = 440;

export function AppShell({ sidebar, agentWorkspace, toolPanel, toolPanelVisible }: AppShellProps) {
  const shellRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [conversationWidth, setConversationWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const sidebarWidthRef = useRef(SIDEBAR_WIDTH);
  const previousToolsVisibleRef = useRef(toolPanelVisible);
  const clampConversationWidth = (width: number): number => {
    const shellWidth = shellRef.current?.clientWidth ?? window.innerWidth;
    const maxWidth = Math.max(
      MIN_CONVERSATION_WIDTH,
      shellWidth - SIDEBAR_WIDTH - DIVIDER_WIDTH - 320,
    );
    return Math.min(Math.max(width, MIN_CONVERSATION_WIDTH), maxWidth);
  };

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    const conversation = conversationRef.current;
    if (!conversation) {
      return;
    }
    event.preventDefault();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: conversation.getBoundingClientRect().width,
    };
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    setConversationWidth(clampConversationWidth(resizeState.startWidth + event.clientX - resizeState.startX));
  };

  const handleResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    resizeRef.current = null;
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const shellStyle = conversationWidth === null
    ? undefined
    : ({ "--conversation-track": `${conversationWidth}px` } as CSSProperties);

  useLayoutEffect(() => {
    if (conversationWidth !== null || !conversationRef.current) {
      return;
    }
    const width = conversationRef.current.getBoundingClientRect().width;
    if (width > 0) {
      setConversationWidth(Math.round(width));
    }
  }, [conversationWidth]);

  useEffect(() => {
    const handleWindowResize = () => {
      setConversationWidth((current) => (
        current === null ? current : clampConversationWidth(current)
      ));
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  useEffect(() => {
    if (!toolPanelVisible) {
      previousToolsVisibleRef.current = false;
      return;
    }
    setConversationWidth((current) => {
      const shellWidth = shellRef.current?.clientWidth ?? window.innerWidth;
      const sidebarWidth = sidebarVisible
        ? shellRef.current?.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect().width ?? SIDEBAR_WIDTH
        : 0;
      const dividerWidth = shellRef.current?.querySelector<HTMLElement>(".workbench-divider")?.getBoundingClientRect().width ?? DIVIDER_WIDTH;
      const openingTools = !previousToolsVisibleRef.current;
      previousToolsVisibleRef.current = true;
      if (openingTools || current === null) {
        return clampConversationWidth(shellWidth - sidebarWidth - dividerWidth - shellWidth / 3);
      }
      return clampConversationWidth(current);
    });
  }, [toolPanelVisible]);

  const toggleSidebar = () => {
    setSidebarVisible((visible) => {
      if (toolPanelVisible && conversationWidth !== null) {
        const measuredWidth = shellRef.current?.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect().width;
        if (measuredWidth && measuredWidth > 0) sidebarWidthRef.current = measuredWidth;
        const sidebarWidth = measuredWidth && measuredWidth > 0 ? measuredWidth : sidebarWidthRef.current;
        setConversationWidth((current) => current === null
          ? current
          : Math.max(MIN_CONVERSATION_WIDTH, current + (visible ? sidebarWidth : -sidebarWidth)));
      }
      return !visible;
    });
  };

  return (
    <div className="desktop-shell">
      <div className="app-toolbar" role="toolbar" aria-label="应用工具栏">
        <button
          className="app-toolbar-toggle"
          type="button"
          title={sidebarVisible ? "隐藏工作区" : "显示工作区"}
          aria-label={sidebarVisible ? "隐藏工作区" : "显示工作区"}
          onClick={toggleSidebar}
        >
          {sidebarVisible ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <span className="app-menu-item">File</span>
        <span className="app-menu-item">Edit</span>
        <span className="app-menu-item">View</span>
        <span className="app-menu-item">Help</span>
      </div>
    <main
      ref={shellRef}
      className={`workbench ${isResizing ? "is-resizing" : ""} ${toolPanelVisible ? "tools-visible" : ""} ${sidebarVisible ? "" : "sidebar-hidden"}`}
      style={shellStyle}
    >
      {sidebarVisible ? sidebar : null}
      <div ref={conversationRef} className="workbench-conversation">
        {agentWorkspace}
      </div>
      {toolPanelVisible && <div
        className="workbench-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整对话与工具插件宽度"
        title="拖动调整对话与工具插件宽度"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />}
      <aside className={`tool-panel ${toolPanelVisible ? "" : "is-hidden"}`}>{toolPanel}</aside>
    </main>
    </div>
  );
}
