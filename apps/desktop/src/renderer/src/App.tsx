import { useCallback, useEffect, useRef, useState } from "react";
import { AgentWorkspace } from "./components/AgentWorkspace";
import { AppShell } from "./components/AppShell";
import { RagManager } from "./components/RagManager";
import { SessionSidebar } from "./components/SessionSidebar";
import { ToolPanel } from "./components/ToolPanel";
import { SettingsPage, type AppFont, type AppPalette, type AppTheme, type CodeFont } from "./components/SettingsPage";
import { PluginsPage, PluginsSidebar, type PluginKind } from "./components/PluginsPage";
import { useDesktopWorkbench } from "./hooks/useDesktopWorkbench";

function useStableCallback<T extends (...args: any[]) => any>(callback: T): T {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
}

export default function App() {
  const { statusMessage, agent, team } = useDesktopWorkbench();
  const [toolPanelVisible, setToolPanelVisible] = useState(false);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [reviewTurnId, setReviewTurnId] = useState<string | null>(null);
  const [reviewFilePath, setReviewFilePath] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pluginKind, setPluginKind] = useState<PluginKind>("mcp");
  const [pluginWorkspace, setPluginWorkspace] = useState("");
  const [theme, setTheme] = useState<AppTheme>(() => (localStorage.getItem("buffeed.theme") as AppTheme) || "light");
  const [palette, setPalette] = useState<AppPalette>(() => {
    const value = localStorage.getItem("buffeed.palette") as AppPalette | null;
    return value && ["teal", "blue", "violet", "orange", "rose", "green", "mono"].includes(value) ? value : "teal";
  });
  const [accentLightness, setAccentLightness] = useState(() => {
    const value = Number(localStorage.getItem("buffeed.accent-lightness") ?? 52);
    return Number.isFinite(value) ? Math.min(72, Math.max(30, value)) : 52;
  });
  const [uiFont, setUiFont] = useState<AppFont>(() => (localStorage.getItem("buffeed.ui-font") as AppFont) || (localStorage.getItem("buffeed.font") as AppFont) || "misans");
  const [codeFont, setCodeFont] = useState<CodeFont>(() => (localStorage.getItem("buffeed.code-font") as CodeFont) || "cascadia");
  const [uiFontSize, setUiFontSize] = useState(() => {
    const value = Number(localStorage.getItem("buffeed.ui-font-size") ?? 14);
    return Number.isFinite(value) ? Math.min(20, Math.max(12, value)) : 14;
  });
  const [codeFontSize, setCodeFontSize] = useState(() => {
    const value = Number(localStorage.getItem("buffeed.code-font-size") ?? 12);
    return Number.isFinite(value) ? Math.min(18, Math.max(10, value)) : 12;
  });
  const [layoutScale, setLayoutScale] = useState(() => {
    const raw = localStorage.getItem("buffeed.layout-scale");
    const value = Number(raw ?? 100);
    if (!Number.isFinite(value)) return 100;
    // The first layout implementation treated 120% as the visual baseline.
    // Re-map that persisted value so the new scale is normalized to 100%.
    if (raw !== null && localStorage.getItem("buffeed.layout-scale-version") !== "2") {
      const migrated = Math.round((value / 1.2) / 5) * 5;
      return Math.min(120, Math.max(80, migrated));
    }
    return Math.min(120, Math.max(80, value));
  });
  const [taskHudGlass, setTaskHudGlass] = useState(() => localStorage.getItem("buffeed.task-hud-glass") !== "off");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.palette = palette;
    document.documentElement.dataset.font = uiFont;
    document.documentElement.dataset.codeFont = codeFont;
    document.documentElement.style.setProperty("--ui-font-size", `${uiFontSize}px`);
    document.documentElement.style.setProperty("--code-font-size", `${codeFontSize}px`);
    document.documentElement.style.setProperty("--layout-scale", String((layoutScale / 100) * 1.2));
    document.documentElement.dataset.taskHudGlass = taskHudGlass ? "on" : "off";
    localStorage.setItem("buffeed.theme", theme);
    localStorage.setItem("buffeed.palette", palette);
    localStorage.setItem("buffeed.ui-font", uiFont);
    localStorage.setItem("buffeed.code-font", codeFont);
    localStorage.setItem("buffeed.ui-font-size", String(uiFontSize));
    localStorage.setItem("buffeed.code-font-size", String(codeFontSize));
    localStorage.setItem("buffeed.layout-scale", String(layoutScale));
    localStorage.setItem("buffeed.layout-scale-version", "2");
    localStorage.setItem("buffeed.accent-lightness", String(accentLightness));
    localStorage.setItem("buffeed.task-hud-glass", taskHudGlass ? "on" : "off");
    const hues: Record<AppPalette, number> = { teal: 174, blue: 221, violet: 262, orange: 18, rose: 345, green: 142, mono: 0 };
    const hue = hues[palette];
    const saturation = palette === "mono" ? 0 : 62;
    const dark = theme === "dark";
    const lightness = dark ? Math.min(82, accentLightness + 12) : accentLightness;
    const softLightness = dark ? 28 : 92;
    const root = document.documentElement;
    root.style.setProperty("--app-accent", `hsl(${hue} ${saturation}% ${lightness}%)`);
    root.style.setProperty("--app-accent-hover", `hsl(${hue} ${saturation}% ${Math.min(92, lightness + 10)}%)`);
    root.style.setProperty("--app-accent-soft", `hsl(${hue} ${Math.max(0, saturation - 18)}% ${softLightness}%)`);
    root.style.setProperty("--send-bg", `hsl(${hue} ${saturation}% ${Math.max(26, lightness - 10)}%)`);
    root.style.setProperty("--send-hover", `hsl(${hue} ${saturation}% ${Math.max(32, lightness)}%)`);
    void window.desktop?.setWindowTheme(theme, dark ? "#171716" : "#f7f7f5");
  }, [accentLightness, codeFont, codeFontSize, layoutScale, palette, taskHudGlass, theme, uiFont, uiFontSize]);

  useEffect(() => {
    const titleBar = document.querySelector<HTMLElement>(".app-toolbar, .settings-header");
    if (!titleBar) return undefined;
    const syncTitleBarHeight = () => {
      const devicePixelRatio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      void window.desktop?.setTitleBarOverlayHeight(titleBar.getBoundingClientRect().height / devicePixelRatio);
    };
    const observer = new ResizeObserver(syncTitleBarHeight);
    observer.observe(titleBar);
    syncTitleBarHeight();
    return () => observer.disconnect();
  }, [pluginsOpen, settingsOpen]);

  useEffect(() => {
    if (team.teamObservation?.available) setToolPanelVisible(true);
  }, [team.teamObservation?.available]);

  useEffect(() => {
    setPreviewFilePath(null);
    setReviewTurnId(null);
    setReviewFilePath(null);
  }, [agent.activeSessionId]);

  const handleSettingsBack = useCallback(() => setSettingsOpen(false), []);
  const handlePluginsBack = useCallback(() => setPluginsOpen(false), []);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleOpenPlugins = useCallback(() => {
    setPluginWorkspace(agent.workspace);
    setPluginsOpen(true);
  }, [agent.workspace]);
  const handleToggleTrace = useCallback(() => {
    agent.setTraceExpanded((expanded) => !expanded);
  }, [agent.setTraceExpanded]);
  const handleOpenAttachment = useCallback((path: string) => {
    setPreviewFilePath(path);
    setToolPanelVisible(true);
  }, []);
  const handleReviewChanges = useCallback((turnId?: string, path?: string) => {
    setReviewTurnId(turnId ?? agent.activeTurnId);
    setReviewFilePath(path ?? null);
    setToolPanelVisible(true);
  }, [agent.activeTurnId]);
  const handleToggleToolPanel = useCallback(() => {
    setToolPanelVisible((visible) => !visible);
  }, []);
  const stableStartNewConversation = useStableCallback(agent.startNewConversation);
  const stableSelectSession = useStableCallback(agent.selectSession);
  const stableModelChange = useStableCallback(agent.setModel);
  const stableReasoningEffortChange = useStableCallback(agent.setReasoningEffort);
  const stableCreateSession = useStableCallback(agent.createSession);
  const stableAddInputFiles = useStableCallback(agent.addInputFiles);
  const stableAddClipboardImage = useStableCallback(agent.addClipboardImage);
  const stableAddSessionHistory = useStableCallback(agent.addSessionHistory);
  const stableRemoveAttachment = useStableCallback(agent.removeAttachment);
  const stableSendTurn = useStableCallback(agent.sendTurn);
  const stableConfirmSteer = useStableCallback(agent.confirmSteer);
  const stableEditSteer = useStableCallback(agent.editSteer);
  const stableCancelSteer = useStableCallback(agent.cancelSteer);
  const stableCancelTurn = useStableCallback(agent.cancelTurn);
  const stableRevertChanges = useStableCallback(agent.revertChanges);
  const stableResolveApproval = useStableCallback(agent.resolveApproval);
  const stableForkTurn = useStableCallback(agent.forkTurn);

  if (new URLSearchParams(window.location.search).get("ragManager") === "1") {
    return <RagManager />;
  }

  if (settingsOpen) {
    return (
      <SettingsPage
        theme={theme}
        palette={palette}
        accentLightness={accentLightness}
        uiFont={uiFont}
        codeFont={codeFont}
        uiFontSize={uiFontSize}
        codeFontSize={codeFontSize}
        layoutScale={layoutScale}
        taskHudGlass={taskHudGlass}
        onThemeChange={setTheme}
        onPaletteChange={setPalette}
        onAccentLightnessChange={setAccentLightness}
        onUiFontChange={setUiFont}
        onCodeFontChange={setCodeFont}
        onUiFontSizeChange={setUiFontSize}
        onCodeFontSizeChange={setCodeFontSize}
        onLayoutScaleChange={setLayoutScale}
        onTaskHudGlassChange={setTaskHudGlass}
        onBack={handleSettingsBack}
      />
    );
  }

  if (pluginsOpen) {
    return (
      <AppShell
        sidebar={<PluginsSidebar kind={pluginKind} onKindChange={setPluginKind} onBack={handlePluginsBack} />}
        agentWorkspace={<PluginsPage agentApi={agent.agentApi} workspace={pluginWorkspace} kind={pluginKind} onKindChange={setPluginKind} onWorkspaceChange={setPluginWorkspace} onBack={handlePluginsBack} />}
        toolPanel={null}
        toolPanelVisible={false}
      />
    );
  }

  return (
    <AppShell
      sidebar={(
        <SessionSidebar
          workspace={agent.workspace}
          sessions={agent.sessions}
          activeSessionId={agent.activeSessionId}
          statusMessage={statusMessage}
          onWorkspaceChange={agent.setWorkspace}
          onNewConversation={stableStartNewConversation}
          onSelectSession={stableSelectSession}
          onOpenSettings={handleOpenSettings}
          onOpenPlugins={handleOpenPlugins}
        />
      )}
      agentWorkspace={(
        <AgentWorkspace
          theme={theme}
          agentApi={agent.agentApi}
          activeSession={agent.activeSession}
          sessions={agent.sessions}
          activeSessionId={agent.activeSessionId}
          approvals={agent.approvals}
          messages={agent.messages}
          streamingMessageIds={agent.streamingMessageIds}
          streamingPreviewOrders={agent.streamingPreviewOrders}
          latestConversationTurnId={agent.latestConversationTurnId}
          latestConversationEvents={agent.latestConversationEvents}
          conversationEvents={agent.conversationEvents}
          taskHUD={agent.taskHUD}
          taskHUDByTurn={agent.taskHUDByTurn}
          activeTurnId={agent.activeTurnId}
          turnSubmitting={agent.turnSubmitting}
          pendingSteerText={agent.pendingSteerText}
          turnElapsedSeconds={agent.turnElapsedSeconds}
          turnPhase={agent.turnPhase}
          traceExpanded={agent.traceExpanded}
          prompt={agent.prompt}
          model={agent.model}
          modelOptions={agent.modelOptions}
          onModelChange={stableModelChange}
          reasoningEffort={agent.reasoningEffort}
          onReasoningEffortChange={stableReasoningEffortChange}
          onToggleTrace={handleToggleTrace}
          onPromptChange={agent.setPrompt}
          onCreateSession={stableCreateSession}
          attachments={agent.attachments}
          onAddInputFiles={stableAddInputFiles}
          onAddClipboardImage={stableAddClipboardImage}
          onAddSessionHistory={stableAddSessionHistory}
          onRemoveAttachment={stableRemoveAttachment}
          onOpenAttachment={handleOpenAttachment}
          onSendTurn={stableSendTurn}
          onConfirmSteer={stableConfirmSteer}
          onEditSteer={stableEditSteer}
          onCancelSteer={stableCancelSteer}
          onCancelTurn={stableCancelTurn}
          onRevertChanges={stableRevertChanges}
          onReviewChanges={handleReviewChanges}
          onResolveApproval={stableResolveApproval}
          onForkTurn={stableForkTurn}
          toolPanelVisible={toolPanelVisible}
          onToggleToolPanel={handleToggleToolPanel}
        />
      )}
      toolPanel={<ToolPanel workspace={agent.workspace} teamObservation={team.teamObservation} teamObservationError={team.teamObservationError} previewFilePath={previewFilePath} reviewFiles={(reviewTurnId ? agent.taskHUDByTurn[reviewTurnId]?.fileChanges : agent.taskHUD.fileChanges) ?? []} reviewTurnId={reviewTurnId} reviewFilePath={reviewFilePath} />}
      toolPanelVisible={toolPanelVisible}
    />
  );
}
