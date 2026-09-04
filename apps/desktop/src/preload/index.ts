import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  selectWorkspace: () => ipcRenderer.invoke("desktop:select-workspace") as Promise<string | null>,
  selectInputPaths: (mode: "file" | "folder", workspace?: string) => ipcRenderer.invoke("desktop:select-input-paths", mode, workspace) as Promise<Array<{ path: string; name: string; kind: "file" | "folder" | "image" | "video"; mimeType?: string; previewUrl?: string }>>,
  saveClipboardImage: (workspace?: string) => ipcRenderer.invoke("desktop:save-clipboard-image", workspace) as Promise<{ path: string; name: string; dataUrl: string; mimeType: string } | null>,
  writeClipboardText: (text: string) => ipcRenderer.invoke("desktop:write-clipboard-text", text) as Promise<void>,
  attachmentThumbnail: (filePath: string) => ipcRenderer.invoke("desktop:attachment-thumbnail", filePath) as Promise<string | undefined>,
  voiceTranscribe: (wavBase64: string) => ipcRenderer.invoke("desktop:voice-transcribe", wavBase64) as Promise<{ text: string; engine: string }>,
  stageRagFile: () =>
    ipcRenderer.invoke("desktop:stage-rag-file") as Promise<{
      gatewayPath: string;
      name: string;
    } | null>,
  apiBaseUrl: () => ipcRenderer.invoke("desktop:api-base-url") as Promise<string>,
  setWindowTheme: (theme: "light" | "dark", backgroundColor: string) => ipcRenderer.invoke("desktop:set-window-theme", theme, backgroundColor) as Promise<void>,
  setTitleBarOverlayHeight: (height: number) => ipcRenderer.invoke("desktop:set-titlebar-overlay-height", height) as Promise<void>,
  openSessionWindow: (sessionId: string) => ipcRenderer.invoke("desktop:open-session-window", sessionId) as Promise<void>,
  openRagManager: () => ipcRenderer.invoke("desktop:open-rag-manager") as Promise<void>,
  selectPreviewFile: () => ipcRenderer.invoke("desktop:select-preview-file") as Promise<{
    path: string;
    name: string;
    extension: string;
    kind: "markdown" | "mermaid" | "text" | "json" | "yaml" | "image" | "video" | "pdf" | "doc" | "docx" | "presentation" | "spreadsheet";
    mimeType: string;
    content: string;
    pages?: string[];
  } | null>,
  previewAttachmentFile: (filePath: string) => ipcRenderer.invoke("desktop:select-preview-file", filePath) as Promise<{
    path: string;
    name: string;
    extension: string;
    kind: "markdown" | "mermaid" | "text" | "json" | "yaml" | "image" | "video" | "pdf" | "doc" | "docx" | "presentation" | "spreadsheet";
    mimeType: string;
    content: string;
    pages?: string[];
  }>,
  previewEditors: () => ipcRenderer.invoke("desktop:preview-editors") as Promise<Array<{
    id: string;
    name: string;
  }>>,
  openPreviewFile: (filePath: string, editorId: string) =>
    ipcRenderer.invoke("desktop:open-preview-file", filePath, editorId) as Promise<void>,
  devServers: (workspace: string) => ipcRenderer.invoke("desktop:dev-servers", workspace) as Promise<Array<{ id: string; label: string; command: string; cwd: string; url: string }>>,
  startDevServer: (candidate: { id: string; label: string; command: string; cwd: string; url: string }) => ipcRenderer.invoke("desktop:start-dev-server", candidate) as Promise<void>,
  terminal: {
    create: (workspace?: string) => ipcRenderer.invoke("desktop:terminal-create", workspace) as Promise<{ id: string }>,
    write: (id: string, input: string) => ipcRenderer.invoke("desktop:terminal-write", id, input) as Promise<void>,
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke("desktop:terminal-resize", id, cols, rows) as Promise<void>,
    close: (id: string) => ipcRenderer.invoke("desktop:terminal-close", id) as Promise<void>,
    onOutput: (listener: (event: { id: string; data: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
      ipcRenderer.on("desktop:terminal-output", handler);
      return () => ipcRenderer.removeListener("desktop:terminal-output", handler);
    },
    onExit: (listener: (event: { id: string; code: number | null; signal: string | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
      ipcRenderer.on("desktop:terminal-exit", handler);
      return () => ipcRenderer.removeListener("desktop:terminal-exit", handler);
    },
  },
  browser: {
    navigate: (url: string) => ipcRenderer.invoke("desktop:browser-navigate", url) as Promise<void>,
    back: () => ipcRenderer.invoke("desktop:browser-back") as Promise<void>,
    forward: () => ipcRenderer.invoke("desktop:browser-forward") as Promise<void>,
    reload: () => ipcRenderer.invoke("desktop:browser-reload") as Promise<void>,
    openDevTools: () => ipcRenderer.invoke("desktop:browser-devtools") as Promise<void>,
    close: () => ipcRenderer.invoke("desktop:browser-close") as Promise<void>,
    detach: () => ipcRenderer.invoke("desktop:browser-detach") as Promise<void>,
    attach: () => ipcRenderer.invoke("desktop:browser-attach") as Promise<void>,
    onDownload: (listener: (event: { name: string; path: string; status: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
      ipcRenderer.on("desktop:browser-download", handler);
      return () => ipcRenderer.removeListener("desktop:browser-download", handler);
    },
    newTab: () => ipcRenderer.invoke("desktop:browser-new-tab") as Promise<void>,
    duplicateTab: () => ipcRenderer.invoke("desktop:browser-duplicate-tab") as Promise<void>,
    switchTab: (tabId: string) => ipcRenderer.invoke("desktop:browser-switch-tab", tabId) as Promise<void>,
    closeTab: (tabId?: string) => ipcRenderer.invoke("desktop:browser-close-tab", tabId) as Promise<void>,
    tabs: () => ipcRenderer.invoke("desktop:browser-tabs") as Promise<{
      url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
      tabs: Array<{ id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }>;
      activeTabId: string | null;
    }>,
    setBounds: (bounds: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }) => {
      ipcRenderer.send("desktop:browser-bounds", bounds);
    },
    onState: (listener: (state: {
      url: string;
      title: string;
      loading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
      tabs: Array<{ id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }>;
      activeTabId: string | null;
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on("desktop:browser-state", handler);
      return () => ipcRenderer.removeListener("desktop:browser-state", handler);
    },
  },
});
