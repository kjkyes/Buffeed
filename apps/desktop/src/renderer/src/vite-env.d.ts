/// <reference types="vite/client" />

declare module "pdfjs-dist/build/pdf.worker.mjs";

interface Window {
  desktop?: {
    selectWorkspace: () => Promise<string | null>;
    selectInputPaths: (mode: "file" | "folder", workspace?: string) => Promise<Array<{ path: string; name: string; kind: "file" | "folder" | "image" | "video"; mimeType?: string; previewUrl?: string }>>;
    saveClipboardImage: (workspace?: string) => Promise<{ path: string; name: string; dataUrl: string; mimeType: string } | null>;
    writeClipboardText: (text: string) => Promise<void>;
    attachmentThumbnail: (filePath: string) => Promise<string | undefined>;
    voiceTranscribe: (wavBase64: string) => Promise<{ text: string; engine: string }>;
    stageRagFile: () => Promise<{ gatewayPath: string; name: string } | null>;
    apiBaseUrl: () => Promise<string>;
    setWindowTheme: (theme: "light" | "dark", backgroundColor: string) => Promise<void>;
    openSessionWindow: (sessionId: string) => Promise<void>;
    openRagManager: () => Promise<void>;
    selectPreviewFile: () => Promise<{
      path: string;
      name: string;
      extension: string;
      kind: "markdown" | "mermaid" | "text" | "json" | "yaml" | "image" | "video" | "pdf" | "doc" | "docx" | "presentation" | "spreadsheet";
      mimeType: string;
      content: string;
      pages?: string[];
    } | null>;
    previewAttachmentFile: (filePath: string) => Promise<{
      path: string;
      name: string;
      extension: string;
      kind: "markdown" | "mermaid" | "text" | "json" | "yaml" | "image" | "video" | "pdf" | "doc" | "docx" | "presentation" | "spreadsheet";
      mimeType: string;
      content: string;
      pages?: string[];
    }>;
    previewEditors: () => Promise<Array<{
      id: string;
      name: string;
    }>>;
    openPreviewFile: (filePath: string, editorId: string) => Promise<void>;
    devServers: (workspace: string) => Promise<Array<{ id: string; label: string; command: string; cwd: string; url: string }>>;
    startDevServer: (candidate: { id: string; label: string; command: string; cwd: string; url: string }) => Promise<void>;
    terminal: {
      create: (workspace?: string) => Promise<{ id: string }>;
      write: (id: string, input: string) => Promise<void>;
      resize: (id: string, cols: number, rows: number) => Promise<void>;
      close: (id: string) => Promise<void>;
      onOutput: (listener: (event: { id: string; data: string }) => void) => () => void;
      onExit: (listener: (event: { id: string; code: number | null; signal: string | null }) => void) => () => void;
    };
    browser: {
      navigate: (url: string) => Promise<void>;
      back: () => Promise<void>;
      forward: () => Promise<void>;
      reload: () => Promise<void>;
      openDevTools: () => Promise<void>;
      close: () => Promise<void>;
      detach: () => Promise<void>;
      attach: () => Promise<void>;
      onDownload: (listener: (event: { name: string; path: string; status: string }) => void) => () => void;
      newTab: () => Promise<void>;
      duplicateTab: () => Promise<void>;
      switchTab: (tabId: string) => Promise<void>;
      closeTab: (tabId?: string) => Promise<void>;
      tabs: () => Promise<{
        url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
        tabs: Array<{ id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }>;
        activeTabId: string | null;
      }>;
      setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
      onState: (listener: (state: {
        url: string;
        title: string;
        loading: boolean;
        canGoBack: boolean;
        canGoForward: boolean;
        tabs: Array<{ id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }>;
        activeTabId: string | null;
      }) => void) => () => void;
    };
  };
}
