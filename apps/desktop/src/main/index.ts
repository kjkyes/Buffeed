import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, session, shell, WebContentsView } from "electron";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import * as pty from "node-pty";
import WordExtractor from "word-extractor";

import { desktopApiBaseUrl, startBackend, stopBackend } from "./backend";

app.setName("Buffeed");
app.setAppUserModelId("cc.buffeed.desktop");

let mainWindow: BrowserWindow | undefined;
let ragManagerWindow: BrowserWindow | undefined;
const sessionWindows = new Set<BrowserWindow>();
type BrowserTab = { id: string; view: WebContentsView };
const browserTabs = new Map<string, BrowserTab>();
let activeBrowserTabId: string | undefined;
let browserBounds: BrowserBounds | undefined;
let browserBridgeToken = randomUUID();
let browserBridgeServer: ReturnType<typeof createServer> | undefined;
let isQuitting = false;
let titleBarOverlayHeight = 36;
let titleBarSymbolColor = "#262622";
type TerminalSession = { id: string; cwd: string; process: pty.IPty };
const terminalSessions = new Map<string, TerminalSession>();

const BROWSER_SCROLLBAR_CSS = `
  html { overflow: auto !important; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    min-height: 28px;
    border: 2px solid transparent;
    border-radius: 999px;
    background: rgba(140, 140, 140, 0.62);
    background-clip: padding-box;
  }
  ::-webkit-scrollbar-thumb:hover { background: rgba(170, 170, 170, 0.78); background-clip: padding-box; }
`;

const execFileAsync = promisify(execFile);
const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const BINARY_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_PREVIEW_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
const approvedPreviewPaths = new Set<string>();
const officePreviewCache = new Map<string, string[]>();
type VideoPreviewResult = { mimeType: string; content: string };
const videoPreviewCache = new Map<string, VideoPreviewResult>();
const configuredPreviewCacheAgeDays = Number(process.env.DESKTOP_VIDEO_PREVIEW_CACHE_MAX_AGE_DAYS ?? "14");
const configuredPreviewCacheMaxBytes = Number(process.env.DESKTOP_VIDEO_PREVIEW_CACHE_MAX_BYTES ?? String(1024 * 1024 * 1024));
const VIDEO_PREVIEW_CACHE_MAX_AGE_MS = (Number.isFinite(configuredPreviewCacheAgeDays) && configuredPreviewCacheAgeDays > 0 ? configuredPreviewCacheAgeDays : 14) * 86_400_000;
const VIDEO_PREVIEW_CACHE_MAX_BYTES = Number.isFinite(configuredPreviewCacheMaxBytes) && configuredPreviewCacheMaxBytes > 0
  ? configuredPreviewCacheMaxBytes
  : 1024 * 1024 * 1024;
let windowBackgroundColor = "#f7f7f5";
let whisperPreparation: Promise<{ executable: string; model: string }> | undefined;

function whisperStorageRoot(): string {
  return process.platform === "win32"
    ? path.join(process.env.SystemDrive || "C:", "Buffeed", "models", "whisper")
    : path.join(app.getPath("userData"), "models", "whisper");
}

function whisperModelPath(): string {
  const configured = process.env.WHISPER_CPP_MODEL_PATH?.trim();
  return configured ? path.resolve(configured) : path.join(whisperStorageRoot(), "ggml-base.bin");
}

async function ensureWhisperModel(): Promise<string> {
  const target = whisperModelPath();
  try {
    if ((await stat(target)).size > 10 * 1024 * 1024) return target;
  } catch { /* Require a local model file. */ }
  throw new Error(`未找到本地 Whisper 模型：${target}。请将 ggml-base.bin 放到该路径，或设置 WHISPER_CPP_MODEL_PATH`);
}

function whisperRuntimeRoot(): string {
  return path.join(whisperStorageRoot(), "runtime");
}

async function findFileRecursive(root: string, fileName: string): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return candidate;
      if (entry.isDirectory()) {
        const nested = await findFileRecursive(candidate, fileName);
        if (nested) return nested;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function findWhisperBinary(): Promise<string | null> {
  const configured = process.env.WHISPER_CPP_BIN?.trim();
  if (configured && existsSync(configured)) return path.resolve(configured);
  const root = app.isPackaged ? path.join(process.resourcesPath, "voice") : path.join(projectRoot(), ".desktop-voice");
  const localName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const bundled = path.join(root, localName);
  if (existsSync(bundled)) return bundled;
  try {
    const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [localName], { windowsHide: true });
    const candidate = String(stdout).split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    return candidate && existsSync(candidate) ? candidate : null;
  } catch { /* Continue with local runtime lookup. */ }
  const runtimeBinary = await findFileRecursive(whisperRuntimeRoot(), localName);
  if (runtimeBinary) return runtimeBinary;
  return null;
}

function prepareWhisperRuntime(): Promise<{ executable: string; model: string }> {
  if (!whisperPreparation) {
    whisperPreparation = (async () => {
      const executable = await findWhisperBinary();
      if (!executable) throw new Error(`未找到本地 whisper.cpp 引擎。请将 whisper-cli${process.platform === "win32" ? ".exe" : ""} 放入 ${whisperRuntimeRoot()}，或设置 WHISPER_CPP_BIN`);
      const model = await ensureWhisperModel();
      return { executable, model };
    })();
  }
  return whisperPreparation;
}

async function transcribeWithWhisper(wavBase64: string): Promise<{ text: string; engine: string }> {
  if (!wavBase64 || wavBase64.length > 45_000_000) throw new Error("录音文件过大");
  let runtime: { executable: string; model: string };
  try {
    runtime = await prepareWhisperRuntime();
  } catch (error) {
    whisperPreparation = undefined;
    throw new Error(`准备本地语音引擎失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const { executable, model } = runtime;
  let tempRoot: string;
  try {
    const tempBase = process.platform === "win32" ? path.join(whisperStorageRoot(), "tmp") : os.tmpdir();
    await mkdir(tempBase, { recursive: true });
    tempRoot = await mkdtemp(path.join(tempBase, "buffeed-voice-"));
  } catch (error) {
    throw new Error(`创建语音临时目录失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const wavPath = path.join(tempRoot, "input.wav");
  try {
    let wav: Buffer;
    try {
      wav = Buffer.from(wavBase64, "base64");
    } catch (error) {
      throw new Error(`录音数据解码失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("录音编码不是有效 WAV");
    }
    const wavView = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const audioFormat = wavView.getUint16(20, true);
    const channels = wavView.getUint16(22, true);
    const sampleRate = wavView.getUint32(24, true);
    const bitsPerSample = wavView.getUint16(34, true);
    const dataSize = wavView.getUint32(40, true);
    if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || sampleRate !== 16_000 || dataSize < 2) {
      throw new Error(`录音 WAV 参数不兼容（格式=${audioFormat}，声道=${channels}，采样率=${sampleRate}，位深=${bitsPerSample}）`);
    }
    try {
      await writeFile(wavPath, wav);
    } catch (error) {
      throw new Error(`写入录音临时文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
    let output: { stdout?: string | Buffer; stderr?: string | Buffer };
    try {
      output = await execFileAsync(executable, ["-m", model, "-f", wavPath, "-l", "zh", "-nt", "-np", "-ng"], { windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
    } catch (error) {
      const detail = error as { stderr?: string | Buffer; message?: string; code?: string | number; signal?: string };
      const stderr = String(detail.stderr ?? "").replace(/\s+/g, " ").trim();
      const exitInfo = detail.signal ? `signal=${detail.signal}` : detail.code !== undefined ? `code=${detail.code}` : "未知退出状态";
      throw new Error(`whisper.cpp 执行失败（${exitInfo}）：${stderr || String(detail.message || error).trim()}`);
    }
    const { stdout, stderr } = output;
    const text = String(stdout ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/^\s*\[[^\]]+\]\s*/gm, "").trim();
    if (!text) {
      const diagnostic = String(stderr ?? "").replace(/\s+/g, " ").trim();
      throw new Error(diagnostic ? `whisper.cpp 未返回识别文本：${diagnostic}` : "whisper.cpp 未返回识别文本");
    }
    return { text, engine: path.basename(executable) };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function applyWindowTheme(theme: "light" | "dark", backgroundColor: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(backgroundColor)) throw new Error("无效的窗口颜色");
  nativeTheme.themeSource = theme;
  windowBackgroundColor = backgroundColor;
  titleBarSymbolColor = theme === "dark" ? "#ecece8" : "#262622";
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.setBackgroundColor(backgroundColor);
    window.setTitleBarOverlay({ color: backgroundColor, symbolColor: titleBarSymbolColor, height: titleBarOverlayHeight });
  }
}

function setTitleBarOverlayHeight(height: number): void {
  if (!Number.isFinite(height) || height < 20 || height > 100) throw new Error("无效的标题栏高度");
  titleBarOverlayHeight = Math.round(height);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.setTitleBarOverlay({ color: windowBackgroundColor, symbolColor: titleBarSymbolColor, height: titleBarOverlayHeight });
  }
}

type PreviewKind = "markdown" | "mermaid" | "text" | "json" | "yaml" | "image" | "video" | "pdf" | "doc" | "docx" | "presentation" | "spreadsheet";
type PreviewFile = {
  path: string;
  name: string;
  extension: string;
  kind: PreviewKind;
  mimeType: string;
  content: string;
  pages?: string[];
};
type EditorInfo = {
  id: string;
  name: string;
  executable: string;
  args: string[];
};

type BrowserBounds = { x: number; y: number; width: number; height: number };
type BrowserBoundsPayload = BrowserBounds & { viewportWidth: number; viewportHeight: number };

function looksLikeCorruptedText(text: string): boolean {
  if (text.includes("\uFFFD")) return true;
  const questionMarks = (text.match(/\?{2,}/g) ?? []).join("").length;
  const hasCjk = /[\u3400-\u9FFF]/u.test(text);
  return !hasCjk && questionMarks >= 4 && questionMarks / Math.max(1, text.length) > 0.01;
}

function browserState() {
  const tabs = [...browserTabs.values()].flatMap(({ id, view }) => {
    try {
      if (view.webContents.isDestroyed()) return [];
      return [{ id, url: view.webContents.getURL(), title: view.webContents.getTitle() || "新标签页", loading: view.webContents.isLoading(), canGoBack: view.webContents.canGoBack(), canGoForward: view.webContents.canGoForward() }];
    } catch {
      return [];
    }
  });
  const active = tabs.find((tab) => tab.id === activeBrowserTabId) ?? tabs[0];
  return {
    url: active?.url ?? "", title: active?.title ?? "新标签页", loading: active?.loading ?? false,
    canGoBack: active?.canGoBack ?? false, canGoForward: active?.canGoForward ?? false,
    tabs, activeTabId: active?.id ?? null,
  };
}

function sendBrowserState(): void {
  sendRendererMessage("desktop:browser-state", browserState());
}

function sendRendererMessage(channel: string, payload: unknown): void {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
  } catch { /* Renderer teardown may race with callbacks. */ }
}

function assertBrowserUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("浏览器只允许打开 http 或 https 地址");
  }
  return url.toString();
}

function assertBrowserBounds(value: unknown): BrowserBounds {
  if (!value || typeof value !== "object") {
    throw new Error("无效的浏览器面板尺寸");
  }
  const bounds = value as Partial<BrowserBoundsPayload>;
  const numbers = [bounds.x, bounds.y, bounds.width, bounds.height, bounds.viewportWidth, bounds.viewportHeight];
  if (numbers.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("无效的浏览器面板尺寸");
  }
  if (bounds.viewportWidth! <= 0 || bounds.viewportHeight! <= 0) {
    throw new Error("无效的浏览器面板尺寸");
  }
  const contentBounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentBounds() : undefined;
  const scaleX = contentBounds ? contentBounds.width / bounds.viewportWidth! : 1;
  const scaleY = contentBounds ? contentBounds.height / bounds.viewportHeight! : 1;
  return {
    x: Math.max(0, Math.round(bounds.x! * scaleX)),
    y: Math.max(0, Math.round(bounds.y! * scaleY)),
    width: Math.max(1, Math.round(bounds.width! * scaleX)),
    height: Math.max(1, Math.round(bounds.height! * scaleY)),
  };
}

function activeBrowserView(): WebContentsView | undefined {
  const tab = activeBrowserTabId ? browserTabs.get(activeBrowserTabId) : undefined;
  return tab && !tab.view.webContents.isDestroyed() ? tab.view : undefined;
}

function ensureBrowserView(): WebContentsView {
  const existing = activeBrowserView();
  if (existing) return existing;
  return createBrowserTab();
}

function createBrowserTab(): WebContentsView {
  if (!mainWindow) {
    throw new Error("桌面窗口尚未创建");
  }
  const id = randomUUID();
  const previous = activeBrowserView();
  if (previous) mainWindow.contentView.removeChildView(previous);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:desktop-browser",
    },
  });
  view.setBackgroundColor("#ffffff");
  browserTabs.set(id, { id, view });
  activeBrowserTabId = id;
  mainWindow.contentView.addChildView(view);
  if (browserBounds) {
    view.setBounds(browserBounds);
  }
  view.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const next = createBrowserTab();
      void next.webContents.loadURL(assertBrowserUrl(url));
    } catch {
      // Ignore blocked or malformed popup URLs.
    }
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, url) => {
    try {
      assertBrowserUrl(url);
    } catch {
      event.preventDefault();
    }
  });
  view.webContents.on("dom-ready", () => {
    void view.webContents.insertCSS(BROWSER_SCROLLBAR_CSS).catch(() => undefined);
  });
  view.webContents.on("did-navigate", sendBrowserState);
  view.webContents.on("did-navigate-in-page", sendBrowserState);
  view.webContents.on("page-title-updated", sendBrowserState);
  view.webContents.on("did-start-loading", sendBrowserState);
  view.webContents.on("did-stop-loading", sendBrowserState);
  view.webContents.session.on("will-download", (_event, item) => {
    const target = path.join(app.getPath("downloads"), item.getFilename());
    item.setSavePath(target);
    item.once("done", (_downloadEvent, state) => sendRendererMessage("desktop:browser-download", { name: item.getFilename(), path: target, status: state }));
  });
  sendBrowserState();
  return view;
}

function destroyBrowserView(): void {
  for (const { view } of browserTabs.values()) {
    disposeBrowserView(view);
  }
  browserTabs.clear();
  activeBrowserTabId = undefined;
}

function disposeBrowserView(view: WebContentsView): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  } catch { /* The BrowserWindow may have completed teardown. */ }
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch { /* Electron can destroy WebContents between the check and close. */ }
}

function switchBrowserTab(tabId: string): void {
  const next = browserTabs.get(tabId);
  if (!next) throw new Error("浏览器标签不存在");
  const previous = activeBrowserView();
  if (previous && mainWindow && previous !== next.view) mainWindow.contentView.removeChildView(previous);
  activeBrowserTabId = tabId;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.addChildView(next.view);
    if (browserBounds) next.view.setBounds(browserBounds);
  }
  sendBrowserState();
}

function closeBrowserTab(tabId?: string): void {
  const id = tabId ?? activeBrowserTabId;
  if (!id) return;
  const tab = browserTabs.get(id);
  if (!tab) return;
  disposeBrowserView(tab.view);
  browserTabs.delete(id);
  if (activeBrowserTabId === id) activeBrowserTabId = [...browserTabs.keys()][0];
  if (activeBrowserTabId) switchBrowserTab(activeBrowserTabId);
  else sendBrowserState();
}

async function createTerminal(workspace?: string): Promise<{ id: string }> {
  const cwd = path.resolve(workspace || projectRoot());
  if (!existsSync(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("终端工作目录不存在");
  const id = randomUUID();
  const defaultPowerShell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const configuredShell = process.env.BUFFEED_DESKTOP_SHELL?.trim();
  const command = process.platform === "win32"
    ? configuredShell || defaultPowerShell
    : (process.env.SHELL || "/bin/bash");
  const isPowerShell = process.platform === "win32" && /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(command);
  const args = process.platform === "win32"
    ? isPowerShell
      ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding; powershell.exe -NoLogo -NoProfile"]
      : []
    : ["-i"];
  const child = pty.spawn(command, args, { cwd, env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>, cols: 120, rows: 32, useConpty: process.platform === "win32" });
  terminalSessions.set(id, { id, cwd, process: child });
  child.onData((data) => sendRendererMessage("desktop:terminal-output", { id, data }));
  child.onExit(({ exitCode, signal }) => {
    terminalSessions.delete(id);
    sendRendererMessage("desktop:terminal-exit", { id, code: exitCode, signal: String(signal) });
  });
  return { id };
}

function writeTerminal(id: string, input: string): void {
  if (typeof input !== "string" || input.length > 100_000) throw new Error("终端输入过长");
  const session = terminalSessions.get(id);
  if (!session) throw new Error("终端会话不存在");
  session.process.write(input);
}

function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = terminalSessions.get(id);
  if (!session) return;
  const nextCols = Math.max(20, Math.min(400, Math.floor(cols)));
  const nextRows = Math.max(5, Math.min(200, Math.floor(rows)));
  session.process.resize(nextCols, nextRows);
}

function closeTerminal(id: string): void {
  const session = terminalSessions.get(id);
  if (!session) return;
  session.process.kill();
  terminalSessions.delete(id);
}

function projectRoot(): string {
  return path.resolve(app.getAppPath(), "..", "..");
}

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "buffeed-logo.ico")
    : path.join(__dirname, "..", "..", "assets", "buffeed-logo.ico");
}

type RagIngestPathMode = "auto" | "host" | "container";

function defaultRagHostRoot(mode: RagIngestPathMode): string {
  const configuredHostRoot = process.env.RAG_INGEST_HOST_DIR?.trim();
  if (configuredHostRoot) {
    return path.resolve(configuredHostRoot);
  }
  if (mode !== "container") {
    const configuredRoot = process.env.RAG_INGEST_ROOTS
      ?.split(path.delimiter)
      .map((value) => value.trim())
      .find(Boolean);
    if (configuredRoot) {
      return path.resolve(configuredRoot);
    }
  }
  return app.isPackaged
    ? path.join(app.getPath("userData"), "rag-inputs")
    : path.join(projectRoot(), "data", "rag", "inputs");
}

function ragIngestPathMode(): RagIngestPathMode {
  const configured = process.env.RAG_INGEST_MODE?.trim().toLowerCase();
  if (configured === "host" || configured === "container") {
    return configured;
  }
  if (configured && configured !== "auto") {
    throw new Error("RAG_INGEST_MODE must be auto, host, or container");
  }

  // The desktop process does not inherit variables loaded from the RAG .env
  // file. Host is therefore the safe default; Compose must opt into the
  // container-visible mount explicitly with RAG_INGEST_MODE=container.
  return "host";
}

function configuredContainerRoot(): string {
  const configuredRoot = (
    process.env.RAG_INGEST_GATEWAY_DIR?.trim()
    || process.env.RAG_INGEST_CONTAINER_DIR?.trim()
    || "/srv/rag/ingest"
  );
  return configuredRoot.replace(/\\/g, "/");
}

function createWindow(): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const rendererOrigin = rendererUrl ? new URL(rendererUrl).origin : undefined;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: windowBackgroundColor,
      symbolColor: titleBarSymbolColor,
      height: titleBarOverlayHeight,
    },
    title: "Buffeed",
    icon: appIconPath(),
    backgroundColor: windowBackgroundColor,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setIcon(appIconPath());
  mainWindow.on("closed", destroyBrowserView);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const isDevUrl = rendererOrigin !== undefined && new URL(url).origin === rendererOrigin;
    const isLocalFile = url.startsWith("file:");
    if (!isDevUrl && !isLocalFile) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function openSessionWindow(sessionId: string): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 720,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: windowBackgroundColor,
      symbolColor: titleBarSymbolColor,
      height: titleBarOverlayHeight,
    },
    title: "Buffeed",
    icon: appIconPath(),
    backgroundColor: windowBackgroundColor,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setIcon(appIconPath());
  sessionWindows.add(window);
  window.on("closed", () => sessionWindows.delete(window));
  const query = `?sessionId=${encodeURIComponent(sessionId)}`;
  if (rendererUrl) void window.loadURL(`${rendererUrl}${query}`);
  else void window.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { sessionId } });
}

function openRagManagerWindow(): void {
  if (ragManagerWindow && !ragManagerWindow.isDestroyed()) {
    ragManagerWindow.focus();
    return;
  }
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  ragManagerWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: "RAG 知识库管理",
    icon: appIconPath(),
    backgroundColor: windowBackgroundColor,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  ragManagerWindow.setIcon(appIconPath());
  ragManagerWindow.on("closed", () => { ragManagerWindow = undefined; });
  if (rendererUrl) void ragManagerWindow.loadURL(`${rendererUrl}?ragManager=1`);
  else void ragManagerWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { ragManager: "1" } });
}

async function selectWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "选择工作区",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

type InputPath = { path: string; name: string; kind: "file" | "folder" | "image" | "video"; mimeType?: string; previewUrl?: string };

const ATTACHMENT_THUMBNAIL_WIDTH = 320;
const ATTACHMENT_THUMBNAIL_HEIGHT = 180;

async function findFfmpegExecutable(): Promise<string | null> {
  const configured = process.env.DESKTOP_FFMPEG?.trim();
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const candidates = [
    configured,
    await executableFromPath("ffmpeg.exe"),
    await registeredExecutable("ffmpeg.exe"),
    path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe"),
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
    localAppData ? path.join(localAppData, "ffmpeg", "bin", "ffmpeg.exe") : undefined,
    localAppData ? path.join(localAppData, "Programs", "ffmpeg", "bin", "ffmpeg.exe") : undefined,
    userProfile ? path.join(userProfile, "scoop", "shims", "ffmpeg.exe") : undefined,
    process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, "Library", "bin", "ffmpeg.exe") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.map(resolvedExecutable).find((candidate): candidate is string => Boolean(candidate)) ?? null;
}

async function createAttachmentThumbnail(filePath: string, mimeType?: string): Promise<string | undefined> {
  if (mimeType?.startsWith("image/")) {
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return undefined;
    const size = image.getSize();
    const scale = Math.min(ATTACHMENT_THUMBNAIL_WIDTH / Math.max(1, size.width), ATTACHMENT_THUMBNAIL_HEIGHT / Math.max(1, size.height), 1);
    const thumbnail = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    }).toJPEG(78);
    return `data:image/jpeg;base64,${thumbnail.toString("base64")}`;
  }
  if (!mimeType?.startsWith("video/")) return undefined;
  const converter = await findFfmpegExecutable();
  if (!converter) return undefined;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "buffeed-thumbnail-"));
  const outputPath = path.join(temporaryRoot, "frame.jpg");
  try {
    await execFileAsync(converter, [
      "-y",
      "-ss", "0",
      "-i", filePath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-vf", `scale=${ATTACHMENT_THUMBNAIL_WIDTH}:${ATTACHMENT_THUMBNAIL_HEIGHT}:force_original_aspect_ratio=decrease`,
      "-q:v", "5",
      outputPath,
    ], { windowsHide: true, timeout: 30_000, maxBuffer: 512 * 1024 });
    if (!existsSync(outputPath)) return undefined;
    const image = nativeImage.createFromPath(outputPath);
    if (image.isEmpty()) return undefined;
    return `data:image/jpeg;base64,${image.toJPEG(78).toString("base64")}`;
  } catch (error) {
    console.warn(`附件视频缩略图生成失败：${filePath}`, error);
    return undefined;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function restoreAttachmentThumbnail(filePath: string): Promise<string | undefined> {
  const file = path.resolve(filePath);
  if (!file.split(path.sep).includes(".desktop-attachments")) {
    throw new Error("只能恢复工作区附件缩略图");
  }
  if (!existsSync(file) || !(await stat(file)).isFile()) return undefined;
  return createAttachmentThumbnail(file, mimeTypeForPath(file));
}

function videoPreviewCacheKey(filePath: string, fileStat: { size: number; mtimeMs: number }): string {
  return createHash("sha256")
    .update(`${path.resolve(filePath)}\0${fileStat.size}\0${fileStat.mtimeMs}`)
    .digest("hex");
}

function videoPreviewCachePath(filePath: string, fileStat: { size: number; mtimeMs: number }): string {
  return path.join(app.getPath("userData"), "video-preview-cache", videoPreviewCacheKey(filePath, fileStat), "preview.mp4");
}

async function previewCacheEntryStats(root: string): Promise<{ size: number; mtimeMs: number }> {
  let size = 0;
  let mtimeMs = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await previewCacheEntryStats(entryPath);
      size += nested.size;
      mtimeMs = Math.max(mtimeMs, nested.mtimeMs);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const metadata = await stat(entryPath);
      size += metadata.size;
      mtimeMs = Math.max(mtimeMs, metadata.mtimeMs);
    } catch {
      // A concurrent conversion may remove an incomplete file.
    }
  }
  try {
    mtimeMs = Math.max(mtimeMs, (await stat(root)).mtimeMs);
  } catch {
    // The cache entry may have disappeared during cleanup.
  }
  return { size, mtimeMs };
}

async function cleanupVideoPreviewCache(): Promise<void> {
  const cacheRoot = path.join(app.getPath("userData"), "video-preview-cache");
  let entries;
  try {
    entries = (await readdir(cacheRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return;
  }
  const now = Date.now();
  const retained: Array<{ root: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    const root = path.join(cacheRoot, entry.name);
    try {
      const metadata = await previewCacheEntryStats(root);
      if (metadata.mtimeMs > 0 && now - metadata.mtimeMs > VIDEO_PREVIEW_CACHE_MAX_AGE_MS) {
        await rm(root, { recursive: true, force: true });
        continue;
      }
      retained.push({ root, ...metadata });
    } catch {
      // Ignore incomplete or concurrently removed cache entries.
    }
  }
  let totalBytes = retained.reduce((total, entry) => total + entry.size, 0);
  for (const entry of retained.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (totalBytes <= VIDEO_PREVIEW_CACHE_MAX_BYTES) break;
    await rm(entry.root, { recursive: true, force: true }).catch(() => undefined);
    totalBytes -= entry.size;
  }
}

async function selectInputPaths(mode: "file" | "folder", workspace?: string): Promise<InputPath[]> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: mode === "folder" ? "选择要引入的文件夹" : "选择要引入的文件",
    properties: mode === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  const root = path.resolve(workspace || projectRoot());
  if (!existsSync(root) || !(await stat(root)).isDirectory()) throw new Error("工作区目录不存在");
  const attachmentRoot = path.join(root, ".desktop-attachments");
  await mkdir(attachmentRoot, { recursive: true });
  const staged: InputPath[] = [];
  for (const sourcePath of result.filePaths) {
    const source = path.resolve(sourcePath);
    if (source === attachmentRoot || source.startsWith(`${attachmentRoot}${path.sep}`)) {
      throw new Error("不能把附件缓存目录再次作为输入");
    }
    const name = path.basename(source);
    const target = path.join(attachmentRoot, `${randomUUID().slice(0, 8)}-${name}`);
    await cp(source, target, { recursive: mode === "folder", force: true });
    approvedPreviewPaths.add(path.resolve(target));
    const mimeType = mimeTypeForPath(name);
    const attachmentKind = mode === "folder"
      ? "folder"
      : mimeType?.startsWith("video/")
        ? "video"
        : mimeType?.startsWith("image/")
          ? "image"
          : "file";
    staged.push({ path: target, name, kind: attachmentKind, mimeType, previewUrl: await createAttachmentThumbnail(target, mimeType) });
  }
  return staged;
}

function mimeTypeForPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".ogv": "video/ogg",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".3gp": "video/3gpp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
  } as Record<string, string>)[extension];
}

async function saveClipboardImage(workspace?: string): Promise<{ path: string; name: string; dataUrl: string; mimeType: string } | null> {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  const dataUrl = image.toDataURL();
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error("剪贴板图片格式不可用");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 25 * 1024 * 1024) throw new Error("剪贴板图片超过 25 MB 限制");
  const root = path.join(path.resolve(workspace || projectRoot()), ".desktop-attachments");
  await mkdir(root, { recursive: true });
  const extension = match[1].split("/")[1].replace("jpeg", "jpg");
  const name = `clipboard-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  const target = path.join(root, name);
  await writeFile(target, bytes);
  approvedPreviewPaths.add(path.resolve(target));
  return { path: target, name, dataUrl: await createAttachmentThumbnail(target, match[1].toLowerCase()) ?? dataUrl, mimeType: match[1].toLowerCase() };
}

function writeClipboardText(text: string): void {
  clipboard.writeText(text);
}

async function stageRagFile(): Promise<{ gatewayPath: string; name: string } | null> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "导入 RAG 文档",
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  const source = result.filePaths[0];
  const maxBytes = Number(process.env.RAG_MAX_UPLOAD_BYTES ?? 104_857_600);
  if ((await stat(source)).size > maxBytes) {
    throw new Error(`文件超过 ${maxBytes} 字节的导入限制`);
  }
  const ingestMode = ragIngestPathMode();
  const hostRoot = defaultRagHostRoot(ingestMode);
  await mkdir(hostRoot, { recursive: true });
  const extension = path.extname(source);
  const baseName = path.basename(source, extension).replace(/[^a-zA-Z0-9._-]/g, "_");
  const stagedName = `${baseName || "document"}-${randomUUID()}${extension}`;
  await copyFile(source, path.join(hostRoot, stagedName));
  return {
    gatewayPath: ingestMode === "host"
      ? path.resolve(hostRoot, stagedName)
      : path.posix.join(configuredContainerRoot(), stagedName),
    name: stagedName,
  };
}

function previewKind(extension: string): PreviewKind {
  if ([".md", ".markdown", ".mdx"].includes(extension)) return "markdown";
  if ([".mmd", ".mermaid"].includes(extension)) return "mermaid";
  if (extension === ".json") return "json";
  if ([".yaml", ".yml"].includes(extension)) return "yaml";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) return "image";
  if ([".mp4", ".webm", ".mov", ".m4v", ".ogv", ".avi", ".mkv", ".flv", ".wmv", ".3gp"].includes(extension)) return "video";
  if (extension === ".pdf") return "pdf";
  if (extension === ".doc") return "doc";
  if (extension === ".docx") return "docx";
  if (extension === ".pptx") return "presentation";
  if ([".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".csv", ".tsv"].includes(extension)) return "spreadsheet";
  return "text";
}

function previewMimeType(extension: string, kind: PreviewKind): string {
  const mimeTypes: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".csv": "text/csv", ".tsv": "text/tab-separated-values",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".ogv": "video/ogg",
    ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv", ".3gp": "video/3gpp",
  };
  if (mimeTypes[extension]) return mimeTypes[extension];
  return kind === "json" ? "application/json" : kind === "yaml" ? "application/yaml" : "text/plain";
}

async function previewFile(filePath: string): Promise<PreviewFile> {
  const fileStat = await stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const kind = previewKind(extension);
  const maxBytes = kind === "video"
    ? VIDEO_PREVIEW_SOURCE_MAX_BYTES
    : ["image", "pdf", "doc", "docx", "presentation", "spreadsheet"].includes(kind)
      ? BINARY_PREVIEW_MAX_BYTES
      : TEXT_PREVIEW_MAX_BYTES;
  if (fileStat.size > maxBytes) {
    throw new Error(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 预览限制`);
  }
  if (kind === "presentation") {
    const cacheKey = `${filePath}\0${fileStat.size}\0${fileStat.mtimeMs}`;
    const cachedPages = officePreviewCache.get(cacheKey);
    const pages = cachedPages ?? await (async () => {
      const convertedPdf = await convertOfficeToPdf(filePath);
      if (!convertedPdf) throw new Error("PPT/PPTX 无法转换为预览页面，请确认 LibreOffice 已安装并可执行");
      return renderPdfPagesToImages(convertedPdf);
    })();
    if (pages.length) {
      officePreviewCache.set(cacheKey, pages);
      while (officePreviewCache.size > 1) {
        const oldestKey = officePreviewCache.keys().next().value;
        if (typeof oldestKey !== "string") break;
        officePreviewCache.delete(oldestKey);
      }
      return {
        path: filePath,
        name: path.basename(filePath),
        extension,
        kind,
        mimeType: "image/jpeg",
        content: "",
        pages,
      };
    }
    throw new Error("PPT/PPTX 没有可用的预览页面");
  }
  if (kind === "video") {
    const cacheKey = videoPreviewCacheKey(filePath, fileStat);
    const cachedVideo = videoPreviewCache.get(cacheKey);
    const conversion = cachedVideo
      ? { result: cachedVideo, error: "" }
      : await transcodeVideoForChromium(filePath, videoPreviewCachePath(filePath, fileStat));
    if (conversion.result) {
      const playable = conversion.result;
      videoPreviewCache.set(cacheKey, playable);
      while (videoPreviewCache.size > 2) {
        const oldestKey = videoPreviewCache.keys().next().value;
        if (typeof oldestKey !== "string") break;
        videoPreviewCache.delete(oldestKey);
      }
      return {
        path: filePath,
        name: path.basename(filePath),
        extension,
        kind,
        mimeType: playable.mimeType,
        content: playable.content,
      };
    }
    throw new Error(conversion.error);
  }
  const binary = ["image", "video", "pdf", "docx", "presentation", "spreadsheet"].includes(kind);
  if (kind === "doc") {
    try {
      const extracted = await new WordExtractor().extract(filePath);
      const content = extracted.getBody({ filterUnicode: false }).trim();
      if (content && !looksLikeCorruptedText(content)) {
        return { path: filePath, name: path.basename(filePath), extension, kind, mimeType: previewMimeType(extension, kind), content };
      }
    } catch {
      // Try the bundled antiword compatibility path below.
    }
    try {
      const { stdout } = await execFileAsync("antiword", [filePath], { windowsHide: true, maxBuffer: TEXT_PREVIEW_MAX_BYTES });
      const content = stdout.trim();
      if (content && !looksLikeCorruptedText(content)) {
        return { path: filePath, name: path.basename(filePath), extension, kind, mimeType: previewMimeType(extension, kind), content };
      }
    } catch {
      // Show a clear explanation below when no parser is available.
    }
    return { path: filePath, name: path.basename(filePath), extension, kind, mimeType: previewMimeType(extension, kind), content: "无法解析此旧版 Word 文档。文档内容可能使用了不兼容的编码，请点击右上角“打开”使用系统 Word 或其他编辑器查看。" };
  }
  return {
    path: filePath,
    name: path.basename(filePath),
    extension,
    kind,
    mimeType: previewMimeType(extension, kind),
    content: binary ? (await readFile(filePath)).toString("base64") : await readFile(filePath, "utf8"),
  };
}

async function transcodeVideoForChromium(filePath: string, outputPath: string): Promise<{ result: VideoPreviewResult | null; error: string }> {
  const converter = await findFfmpegExecutable();
  if (!converter) {
    return { result: null, error: "未找到可执行的 ffmpeg。请确认 ffmpeg 的 bin 目录已加入 PATH，或设置 DESKTOP_FFMPEG 指向 ffmpeg.exe 后重试。" };
  }

  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    if (!existsSync(outputPath)) {
      await execFileAsync(converter, [
        "-y",
        "-i", filePath,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-movflags", "+faststart",
        outputPath,
      ], { windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    }
    if (!existsSync(outputPath)) {
      return { result: null, error: `ffmpeg 已找到，但没有生成预览文件（${converter}）` };
    }
    if ((await stat(outputPath)).size > BINARY_PREVIEW_MAX_BYTES) {
      return { result: null, error: `视频预览转码结果超过 ${Math.floor(BINARY_PREVIEW_MAX_BYTES / 1024 / 1024)} MB 限制` };
    }
    return { result: { mimeType: "video/mp4", content: (await readFile(outputPath)).toString("base64") }, error: "" };
  } catch (error: unknown) {
    const detail = error as { stderr?: string; message?: string };
    const message = String(detail.stderr || detail.message || error).trim();
    console.warn(`视频预览转码失败（${converter}）：${message}`);
    return { result: null, error: `ffmpeg 已找到，但视频转码失败（${converter}）：${message}` };
  }
}

async function convertOfficeToPdf(filePath: string): Promise<Buffer | null> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "buffeed-office-"));
  const temporaryProfile = path.join(temporaryRoot, "profile");
  try {
    await mkdir(temporaryProfile, { recursive: true });
    const profileUri = `file:///${temporaryProfile.replace(/\\/g, "/")}`;
    const configuredConverter = process.env.DESKTOP_OFFICE_CONVERTER ?? process.env.RAG_OFFICE_CONVERTER;
    const candidates = configuredConverter ? [configuredConverter] : [
      await executableFromPath("soffice.exe"),
      await executableFromPath("soffice.com"),
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "LibreOffice", "program", "soffice.exe"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const args = [
      `-env:UserInstallation=${profileUri}`,
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      temporaryRoot,
      filePath,
    ];
    let lastError = "";
    for (const candidate of candidates) {
      if (candidate.includes("\\") && !existsSync(candidate)) continue;
      try {
        await execFileAsync(candidate, args, { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
        const outputPath = path.join(temporaryRoot, `${path.basename(filePath, path.extname(filePath))}.pdf`);
        if (existsSync(outputPath)) return await readFile(outputPath);
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    console.warn(`Office 预览转换失败：${lastError || "未找到 soffice"}`);
    return null;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function renderPdfPagesToImages(pdfContent: Buffer): Promise<string[]> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "buffeed-slides-"));
  const pdfPath = path.join(temporaryRoot, "slides.pdf");
  const outputPrefix = path.join(temporaryRoot, "page");
  try {
    await writeFile(pdfPath, pdfContent);
    const converter = await findPdfRasterizer();
    if (!converter) {
      throw new Error("未找到 pdftoppm 页面截图工具。请安装 Poppler，并将其 Library\\bin 加入 PATH，或设置 DESKTOP_PDF_RENDERER 指向 pdftoppm.exe");
    }
    await execFileAsync(converter, [
      "-jpeg",
      "-r", "120",
      "-jpegopt", "quality=82,optimize=y,progressive=y",
      pdfPath,
      outputPrefix,
    ], { windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const pageFiles = (await readdir(temporaryRoot))
      .filter((name) => /^page-\d+\.jpg$/i.test(name))
      .sort((left, right) => Number(left.match(/(\d+)/)?.[1] ?? 0) - Number(right.match(/(\d+)/)?.[1] ?? 0));
    return Promise.all(pageFiles.map(async (name) => `data:image/jpeg;base64,${(await readFile(path.join(temporaryRoot, name))).toString("base64")}`));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findPdfRasterizer(): Promise<string | null> {
  const configured = process.env.DESKTOP_PDF_RENDERER;
  const candidates = [
    configured,
    await executableFromPath("pdftoppm.exe"),
    await executableFromPath("pdftoppm"),
    path.join(process.resourcesPath, "poppler", "Library", "bin", "pdftoppm.exe"),
    "C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe",
    "C:\\Program Files (x86)\\poppler\\Library\\bin\\pdftoppm.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const directory of await registeredPathEntries()) {
    candidates.push(path.join(directory, "pdftoppm.exe"));
  }
  for (const home of new Set([os.homedir(), process.env.USERPROFILE, process.env.LOCALAPPDATA])) {
    if (!home) continue;
    const popplerRoot = path.join(home, "poppler");
    candidates.push(path.join(popplerRoot, "Library", "bin", "pdftoppm.exe"));
    try {
      const versions = await readdir(popplerRoot, { withFileTypes: true });
      for (const version of versions) {
        if (version.isDirectory()) candidates.push(path.join(popplerRoot, version.name, "Library", "bin", "pdftoppm.exe"));
      }
    } catch {
      // A user-local Poppler installation is optional.
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function registeredPathEntries(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const entries = new Set<string>();
  const addEntries = (value: string | undefined) => {
    if (!value) return;
    for (const entry of value.split(";")) {
      const expanded = entry.trim().replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? _match);
      if (expanded) entries.add(expanded);
    }
  };
  addEntries(process.env.Path);
  addEntries(process.env.PATH);
  addEntries(process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, "Library", "bin") : undefined);
  for (const key of [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ]) {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", key, "/v", "Path"], { windowsHide: true });
      const match = stdout.match(/\bPath\s+REG_EXPAND_SZ\s+(.+)$/im) ?? stdout.match(/\bPath\s+REG_SZ\s+(.+)$/im);
      addEntries(match?.[1]);
    } catch {
      // Registry lookup is only an additional fallback for stale process environments.
    }
  }
  return [...entries];
}

async function selectPreviewFile(requestedPath?: string): Promise<PreviewFile | null> {
  if (requestedPath) {
    return previewAttachmentFile(requestedPath);
  }
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "选择要预览的文件",
    properties: ["openFile"],
    filters: [
      { name: "支持预览的文件", extensions: ["md", "markdown", "mdx", "mmd", "mermaid", "txt", "log", "json", "yaml", "yml", "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "webm", "mov", "m4v", "ogv", "avi", "mkv", "flv", "wmv", "3gp", "pdf", "doc", "docx", "pptx", "xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "tsv"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) {
    return null;
  }
  const resolvedPath = path.resolve(filePath);
  approvedPreviewPaths.add(resolvedPath);
  return previewFile(resolvedPath);
}

function resolvedExecutable(executable: string): string | null {
  const trimmed = executable.trim().replace(/^"|"$/g, "");
  const expanded = trimmed.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? "");
  if (!expanded || !existsSync(expanded)) return null;
  try {
    return statSync(expanded).isFile() ? path.resolve(expanded) : null;
  } catch {
    return null;
  }
}

async function executableFromPath(command: string): Promise<string | null> {
  try {
    const pathCommand = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(pathCommand, [command], { windowsHide: true });
    const candidate = stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    const fromCommand = candidate ? resolvedExecutable(candidate) : null;
    if (fromCommand) return fromCommand;
  } catch {
    // Continue with PATH values that may have changed after Desktop started.
  }
  const commandName = path.basename(command);
  const commandWithExtension = process.platform === "win32" && !/\.exe$/i.test(commandName) ? `${commandName}.exe` : commandName;
  const configuredEntries = [process.env.Path, process.env.PATH]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(path.delimiter));
  const entries = [...configuredEntries, ...(await registeredPathEntries())];
  for (const entry of entries) {
    const candidate = resolvedExecutable(path.join(entry, commandWithExtension));
    if (candidate) return candidate;
  }
  return null;
}

async function registeredExecutable(application: string): Promise<string | null> {
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${application}`, "/ve"], { windowsHide: true });
      const match = stdout.match(/REG_SZ\s+(.+)\s*$/m);
      const executable = match ? resolvedExecutable(match[1].trim().replace(/^"|"$/g, "")) : null;
      if (executable) return executable;
    } catch {
      // Try the next registry hive.
    }
  }
  return null;
}

async function toolboxExecutable(product: string, executable: string): Promise<string | null> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const root = path.join(localAppData, "JetBrains", "Toolbox", "apps", product, "ch-0");
  try {
    const releases = await readdir(root, { withFileTypes: true });
    for (const release of releases) {
      if (!release.isDirectory()) continue;
      const candidate = path.join(root, release.name, "bin", executable);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

async function discoverEditors(): Promise<EditorInfo[]> {
  const candidates = [
    { id: "vscode", name: "Visual Studio Code", command: "code", application: "Code.exe", paths: ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe", "C:\\Program Files\\Microsoft VS Code\\Code.exe"] },
    { id: "cursor", name: "Cursor", command: "cursor", application: "Cursor.exe", paths: ["%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe", "C:\\Program Files\\Cursor\\Cursor.exe"] },
    { id: "vscodium", name: "VSCodium", command: "codium", application: "VSCodium.exe", paths: ["%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe", "C:\\Program Files\\VSCodium\\VSCodium.exe"] },
    { id: "notepadpp", name: "Notepad++", command: "notepad++", application: "notepad++.exe", paths: ["C:\\Program Files\\Notepad++\\notepad++.exe"] },
    { id: "sublime", name: "Sublime Text", command: "subl", application: "sublime_text.exe", paths: ["C:\\Program Files\\Sublime Text\\sublime_text.exe"] },
    { id: "intellij", name: "IntelliJ IDEA", command: "idea", application: "idea64.exe", paths: [], toolbox: "IDEA-U" },
    { id: "pycharm", name: "PyCharm", command: "pycharm", application: "pycharm64.exe", paths: [], toolbox: "PyCharm-P" },
    { id: "webstorm", name: "WebStorm", command: "webstorm", application: "webstorm64.exe", paths: [], toolbox: "WebStorm" },
    { id: "notepad", name: "记事本", command: "notepad", application: "notepad.exe", paths: ["%WINDIR%\\System32\\notepad.exe"] },
  ];
  const editors: EditorInfo[] = [];
  for (const candidate of candidates) {
    const fromPath = await executableFromPath(candidate.command);
    const fromRegistry = fromPath ?? await registeredExecutable(candidate.application);
    const fromToolbox = fromRegistry ?? (candidate.toolbox ? await toolboxExecutable(candidate.toolbox, candidate.application) : null);
    const fromKnownPath = fromToolbox ?? candidate.paths
      .map((candidatePath) => resolvedExecutable(candidatePath))
      .find((value): value is string => Boolean(value));
    if (fromKnownPath && !editors.some((editor) => editor.executable.toLowerCase() === fromKnownPath.toLowerCase())) {
      editors.push({ id: candidate.id, name: candidate.name, executable: fromKnownPath, args: [] });
    }
  }
  return editors;
}

async function openPreviewFile(filePath: string, editorId: string): Promise<void> {
  const file = path.resolve(filePath);
  if (!approvedPreviewPaths.has(file)) {
    throw new Error("只能打开当前会话中选择预览的文件");
  }
  if (!existsSync(file)) {
    throw new Error("文件不存在或已被移动");
  }
  if (editorId === "default") {
    await shell.openPath(file);
    return;
  }
  const editor = (await discoverEditors()).find((item) => item.id === editorId);
  if (!editor) {
    throw new Error("所选编辑器不可用，请刷新后重试");
  }
  const executable = resolvedExecutable(editor.executable);
  if (!executable) {
    throw new Error("编辑器程序不可用");
  }
  spawn(executable, [...editor.args, file], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function previewAttachmentFile(filePath: string): Promise<PreviewFile> {
  const file = path.resolve(filePath);
  if (!approvedPreviewPaths.has(file)) {
    throw new Error("只能预览当前会话中引入的文件");
  }
  if (!existsSync(file) || !(await stat(file)).isFile()) {
    throw new Error("文件不存在或已被移动");
  }
  return previewFile(file);
}

type DevServerCandidate = { id: string; label: string; command: string; cwd: string; url: string };
const devProcesses = new Map<string, ReturnType<typeof spawn>>();

async function scanDevServers(workspace: string): Promise<DevServerCandidate[]> {
  const root = path.resolve(workspace);
  if (!existsSync(root) || !(await stat(root)).isDirectory()) throw new Error("工作区目录不存在");
  const manifestPath = path.join(root, "package.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = manifest.scripts ?? {};
  return ["dev", "start", "preview"].filter((name) => typeof scripts[name] === "string").map((name) => ({
    id: name, label: `npm run ${name}`, command: `npm run ${name}`, cwd: root,
    url: name === "start" ? "http://localhost:3000" : name === "preview" ? "http://localhost:4173" : "http://localhost:5173",
  }));
}

async function startDevServer(candidate: DevServerCandidate): Promise<void> {
  const root = path.resolve(candidate.cwd);
  const candidates = await scanDevServers(root);
  const verified = candidates.find((item) => item.id === candidate.id && item.cwd === root);
  if (!verified) throw new Error("开发脚本已变化，请刷新候选列表");
  if (devProcesses.has(verified.id)) return;
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", verified.id], { cwd: root, env: process.env, windowsHide: true, stdio: "ignore" });
  devProcesses.set(verified.id, child);
  child.on("exit", () => devProcesses.delete(verified.id));
  await ensureBrowserView().webContents.loadURL(assertBrowserUrl(verified.url));
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function startBrowserBridge(): Promise<void> {
  browserBridgeServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.authorization !== `Bearer ${browserBridgeToken}`) return jsonResponse(response, 401, { error: "unauthorized" });
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const view = activeBrowserView();
    try {
      if (request.method === "GET" && url.pathname === "/snapshot") {
        if (!view) return jsonResponse(response, 200, { url: "", title: "", text: "", links: [] });
        const snapshot = await view.webContents.executeJavaScript(`(() => { const selector = (el) => { if (el.id) return '#' + CSS.escape(el.id); const parts = []; while (el && el.nodeType === 1 && parts.length < 5) { let part = el.tagName.toLowerCase(); if (el.parentElement) { const siblings = [...el.parentElement.children].filter(x => x.tagName === el.tagName); if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')'; } parts.unshift(part); el = el.parentElement; } return parts.join(' > '); }; return {url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 20000), links: [...document.querySelectorAll('a')].slice(0, 100).map(a => ({text: (a.innerText || '').trim().slice(0,200), href: a.href, selector: selector(a)})), controls: [...document.querySelectorAll('button,input,textarea,select')].slice(0, 100).map(el => ({tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0,200), selector: selector(el)}))}; })()`);
        return jsonResponse(response, 200, snapshot);
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const payload = body ? JSON.parse(body) : {};
      if (request.method === "POST" && url.pathname === "/navigate") {
        await ensureBrowserView().webContents.loadURL(assertBrowserUrl(String(payload.url ?? "")));
        return jsonResponse(response, 200, browserState());
      }
      if (request.method === "POST" && url.pathname === "/wait") {
        const ms = Math.max(0, Math.min(10_000, Number(payload.ms ?? 500)));
        await new Promise((resolve) => setTimeout(resolve, ms));
        if (!view) return jsonResponse(response, 200, { ok: true });
        const snapshot = await view.webContents.executeJavaScript(`({url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 20000)})`);
        return jsonResponse(response, 200, snapshot);
      }
      if (request.method === "POST" && url.pathname === "/screenshot") {
        if (!view) return jsonResponse(response, 400, { error: "no active tab" });
        const image = await view.webContents.capturePage();
        return jsonResponse(response, 200, { dataUrl: image.toDataURL() });
      }
      if (!view) return jsonResponse(response, 400, { error: "no active tab" });
      if (request.method === "POST" && url.pathname === "/click") {
        const selector = String(payload.selector ?? "").slice(0, 500);
        const clicked = await view.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
        if (!clicked) return jsonResponse(response, 404, { error: "selector not found" });
        return jsonResponse(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/type") {
        const selector = String(payload.selector ?? "").slice(0, 500);
        const value = String(payload.text ?? "").slice(0, 10000);
        const typed = await view.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || !['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return false; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
        if (!typed) return jsonResponse(response, 404, { error: "selector not found" });
        return jsonResponse(response, 200, { ok: true });
      }
      return jsonResponse(response, 404, { error: "not found" });
    } catch (error) { return jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  await new Promise<void>((resolve) => browserBridgeServer!.listen(0, "127.0.0.1", resolve));
}

export function browserBridgeConfig(): { url: string; token: string } | undefined {
  const address = browserBridgeServer?.address();
  if (!address || typeof address === "string") return undefined;
  return { url: `http://127.0.0.1:${address.port}`, token: browserBridgeToken };
}

app.whenReady().then(async () => {
  // Chromium's online SpeechRecognition endpoint rejects Electron's default
  // User-Agent. Use a regular Chrome UA for desktop renderer requests.
  app.userAgentFallback = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
  // SpeechRecognition requests microphone access from the renderer's origin.
  // Explicitly handling both checks is required for packaged file:// windows.
  const isDesktopOrigin = (origin: string) => origin.startsWith("file://")
    || origin.startsWith("http://127.0.0.1")
    || origin.startsWith("http://localhost");
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => (
    permission === "media" && isDesktopOrigin(requestingOrigin)
  ));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === "media" && isDesktopOrigin(webContents.getURL()));
  });
  await cleanupVideoPreviewCache();
  void prepareWhisperRuntime().catch((error) => {
    console.error("[voice] whisper runtime preparation failed", error);
  });
  await startBrowserBridge();
  try {
    await startBackend(browserBridgeConfig());
  } catch (error) {
    await dialog.showMessageBox({
      type: "warning",
      title: "本机 Agent API 未启动",
      message: error instanceof Error ? error.message : String(error),
      detail: "可以检查 Python 环境和 MODEL_ID 后重新打开应用。",
    });
  }
  ipcMain.handle("desktop:select-workspace", selectWorkspace);
  ipcMain.handle("desktop:select-input-paths", (_event, mode: "file" | "folder", workspace?: string) => selectInputPaths(mode, workspace));
  ipcMain.handle("desktop:save-clipboard-image", (_event, workspace?: string) => saveClipboardImage(workspace));
  ipcMain.handle("desktop:write-clipboard-text", (_event, text: string) => writeClipboardText(text));
  ipcMain.handle("desktop:attachment-thumbnail", (_event, filePath: string) => restoreAttachmentThumbnail(filePath));
  ipcMain.handle("desktop:voice-transcribe", (_event, wavBase64: string) => transcribeWithWhisper(wavBase64));
  ipcMain.handle("desktop:stage-rag-file", stageRagFile);
  ipcMain.handle("desktop:select-preview-file", (_event, requestedPath?: string) => selectPreviewFile(requestedPath));
  ipcMain.handle("desktop:preview-editors", discoverEditors);
  ipcMain.handle("desktop:open-preview-file", (_event, filePath: string, editorId: string) => openPreviewFile(filePath, editorId));
  ipcMain.handle("desktop:terminal-create", (_event, workspace?: string) => createTerminal(workspace));
  ipcMain.handle("desktop:terminal-write", (_event, id: string, input: string) => writeTerminal(id, input));
  ipcMain.handle("desktop:terminal-resize", (_event, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows));
  ipcMain.handle("desktop:terminal-close", (_event, id: string) => closeTerminal(id));
  ipcMain.handle("desktop:dev-servers", (_event, workspace: string) => scanDevServers(workspace));
  ipcMain.handle("desktop:start-dev-server", (_event, candidate: DevServerCandidate) => startDevServer(candidate));
  ipcMain.handle("desktop:api-base-url", desktopApiBaseUrl);
  ipcMain.handle("desktop:set-window-theme", (_event, theme: "light" | "dark", backgroundColor: string) => {
    applyWindowTheme(theme, backgroundColor);
  });
  ipcMain.handle("desktop:set-titlebar-overlay-height", (_event, height: number) => {
    setTitleBarOverlayHeight(height);
  });
  ipcMain.handle("desktop:open-session-window", (_event, sessionId: string) => {
    if (!sessionId || sessionId.length > 128) throw new Error("无效的会话 ID");
    openSessionWindow(sessionId);
  });
  ipcMain.handle("desktop:open-rag-manager", openRagManagerWindow);
  ipcMain.handle("desktop:browser-navigate", (_event, rawUrl: string) => {
    const view = ensureBrowserView();
    return view.webContents.loadURL(assertBrowserUrl(rawUrl));
  });
  ipcMain.handle("desktop:browser-back", () => activeBrowserView()?.webContents.canGoBack() && activeBrowserView()!.webContents.goBack());
  ipcMain.handle("desktop:browser-forward", () => activeBrowserView()?.webContents.canGoForward() && activeBrowserView()!.webContents.goForward());
  ipcMain.handle("desktop:browser-reload", () => activeBrowserView()?.webContents.reload());
  ipcMain.handle("desktop:browser-devtools", () => ensureBrowserView().webContents.openDevTools({ mode: "right" }));
  ipcMain.handle("desktop:browser-close", destroyBrowserView);
  ipcMain.handle("desktop:browser-detach", () => {
    const view = activeBrowserView();
    if (view && mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  });
  ipcMain.handle("desktop:browser-attach", () => {
    const view = activeBrowserView();
    if (view && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.addChildView(view);
      if (browserBounds) view.setBounds(browserBounds);
    }
  });
  ipcMain.handle("desktop:browser-new-tab", () => { createBrowserTab(); return browserState(); });
  ipcMain.handle("desktop:browser-duplicate-tab", async () => {
    const source = activeBrowserView();
    const url = source?.webContents.getURL();
    const view = createBrowserTab();
    if (url) await view.webContents.loadURL(assertBrowserUrl(url));
    return browserState();
  });
  ipcMain.handle("desktop:browser-switch-tab", (_event, tabId: string) => { switchBrowserTab(tabId); return browserState(); });
  ipcMain.handle("desktop:browser-close-tab", (_event, tabId?: string) => { closeBrowserTab(tabId); return browserState(); });
  ipcMain.handle("desktop:browser-tabs", () => browserState());
  ipcMain.on("desktop:browser-bounds", (_event, value: unknown) => {
    browserBounds = assertBrowserBounds(value);
    activeBrowserView()?.setBounds(browserBounds);
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (isQuitting) return;
  isQuitting = true;
  for (const child of devProcesses.values()) child.kill();
  for (const session of terminalSessions.values()) session.process.kill();
  terminalSessions.clear();
  browserBridgeServer?.close();
  stopBackend();
});
