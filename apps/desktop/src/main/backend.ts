import { app } from "electron";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function loadProjectEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", "..", ".env"),
  ];
  const envPath = candidates.find((candidate) => existsSync(candidate));
  if (!envPath) return;
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    console.warn(`[desktop-env] failed to load ${envPath}: ${String(error)}`);
  }
}

function loadBuffeedEnv(home: string): void {
  const envPath = path.join(home, ".env");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    console.warn(`[buffeed-env] failed to load ${envPath}: ${String(error)}`);
  }
}

function buffeedHome(): string {
  const configured = process.env.BUFFEED_HOME?.trim();
  if (configured) return path.resolve(configured);
  if (app.isPackaged) return path.join(app.getPath("home"), ".buffeed");
  return path.resolve(process.cwd(), "..", "..", "..", ".buffeed");
}

const sharedBuffeedHome = buffeedHome();
loadBuffeedEnv(sharedBuffeedHome);
loadProjectEnv();

const apiHost = process.env.DESKTOP_API_HOST ?? "127.0.0.1";
const apiPort = Number(process.env.DESKTOP_API_PORT ?? "8765");
let backendProcess: ChildProcess | undefined;
let ragBackendProcess: ChildProcess | undefined;
const ragApiHost = process.env.RAG_MCP_HOST ?? "127.0.0.1";
const ragApiPort = Number(process.env.RAG_MCP_PORT ?? "8001");

function apiAllowedOrigins(): string {
  const origins = new Set(
    (process.env.DESKTOP_ALLOWED_ORIGINS
      ?? "http://127.0.0.1:5173,http://localhost:5173,null")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    origins.add(new URL(rendererUrl).origin);
  }
  return [...origins].join(",");
}

function backendScript(): string {
  if (process.env.DESKTOP_BACKEND_SCRIPT) {
    return path.resolve(process.env.DESKTOP_BACKEND_SCRIPT);
  }
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "backend", "agent-runtime", "desktop_api.py")]
    : [path.resolve(app.getAppPath(), "..", "..", "apps", "agent-runtime", "desktop_api.py")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function pythonExecutable(script: string): string {
  if (process.env.DESKTOP_PYTHON) {
    return process.env.DESKTOP_PYTHON;
  }
  if (process.platform === "win32") {
    const scriptRoot = path.dirname(script);
    const candidates = [
      path.resolve(scriptRoot, ".venv", "Scripts", "python.exe"),
    ];
    const projectPython = candidates.find((candidate) => existsSync(candidate));
    if (projectPython) {
      return projectPython;
    }
  }
  return process.platform === "win32" ? "python.exe" : "python3";
}

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const endpoint = `http://${apiHost}:${apiPort}/health`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Desktop API did not become healthy: ${lastError}`);
}

async function backendIsHealthy(): Promise<boolean> {
  try {
    return (await fetch(`http://${apiHost}:${apiPort}/health`)).ok;
  } catch {
    return false;
  }
}

function ragBackendScript(): string {
  if (process.env.DESKTOP_RAG_BACKEND_SCRIPT) return path.resolve(process.env.DESKTOP_RAG_BACKEND_SCRIPT);
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "backend", "rag", "run.py")]
    : [path.resolve(app.getAppPath(), "..", "..", "apps", "rag", "run.py")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function ragBackendIsHealthy(): Promise<boolean> {
  try { return (await fetch(`http://${ragApiHost}:${ragApiPort}/api/v1/rag/health`)).ok; } catch { return false; }
}

export async function startRagBackend(): Promise<void> {
  if (process.env.DESKTOP_START_RAG !== "true" || ragBackendProcess && !ragBackendProcess.killed || await ragBackendIsHealthy()) return;
  const script = ragBackendScript();
  if (!existsSync(script)) { console.warn(`[rag-api] script not found: ${script}`); return; }
  const ragRoot = path.dirname(script);
  const ragVenvPython = process.platform === "win32"
    ? path.join(ragRoot, ".venv", "Scripts", "python.exe")
    : path.join(ragRoot, ".venv", "bin", "python");
  const python = process.env.DESKTOP_RAG_PYTHON || (existsSync(ragVenvPython) ? ragVenvPython : process.env.DESKTOP_PYTHON || (process.platform === "win32" ? "python.exe" : "python3"));
  ragBackendProcess = spawn(python, [script], {
    cwd: path.dirname(script),
    env: { ...process.env, RAG_MCP_HOST: ragApiHost, RAG_MCP_PORT: String(ragApiPort), RAG_WEB_ALLOWED_ORIGINS: apiAllowedOrigins(), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    stdio: "pipe", windowsHide: true,
  });
  ragBackendProcess.stdout?.on("data", (data) => console.info(`[rag-api] ${String(data).trim()}`));
  ragBackendProcess.stderr?.on("data", (data) => console.error(`[rag-api] ${String(data).trim()}`));
  ragBackendProcess.on("exit", (code) => { ragBackendProcess = undefined; console.info(`[rag-api] exited with code ${code ?? "unknown"}`); });
}

export async function startBackend(bridge?: { url: string; token: string }): Promise<void> {
  if (process.env.DESKTOP_START_BACKEND === "false") {
    return;
  }
  if (backendProcess && !backendProcess.killed) {
    return;
  }
  if (await backendIsHealthy()) {
    return;
  }
  const script = backendScript();
  if (!existsSync(script)) {
    throw new Error(`Desktop API script was not found: ${script}`);
  }
  backendProcess = spawn(pythonExecutable(script), [script], {
    cwd: path.dirname(script),
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      DESKTOP_API_HOST: apiHost,
      DESKTOP_API_PORT: String(apiPort),
      DESKTOP_ALLOWED_ORIGINS: apiAllowedOrigins(),
      DESKTOP_STATE_DIR: process.env.DESKTOP_STATE_DIR
        ?? path.join(sharedBuffeedHome, "state"),
      BUFFEED_HOME: sharedBuffeedHome,
      DESKTOP_BROWSER_BRIDGE_URL: bridge?.url ?? "",
      DESKTOP_BROWSER_BRIDGE_TOKEN: bridge?.token ?? "",
    },
    stdio: "pipe",
    windowsHide: true,
  });
  backendProcess.stdout?.on("data", (data) => {
    console.info(`[desktop-api] ${String(data).trim()}`);
  });
  backendProcess.stderr?.on("data", (data) => {
    console.error(`[desktop-api] ${String(data).trim()}`);
  });
  backendProcess.on("exit", (code) => {
    backendProcess = undefined;
    console.info(`[desktop-api] exited with code ${code ?? "unknown"}`);
  });
  await waitForHealth();
}

export function stopBackend(): void {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
  backendProcess = undefined;
  if (ragBackendProcess && !ragBackendProcess.killed) ragBackendProcess.kill();
  ragBackendProcess = undefined;
}

export function desktopApiBaseUrl(): string {
  return `http://${apiHost}:${apiPort}`;
}
