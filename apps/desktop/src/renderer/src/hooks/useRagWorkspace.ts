import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_RAG_API,
  RAG_PROFILES,
  RAG_TASK_TERMINAL_STATUSES,
  type RagDocument,
  type RagPipelineStatus,
  type RagReadinessReport,
  type RagRetrievalResponse,
  type ProcessingProfile,
  type RagTaskStatusResponse,
} from "../domains/rag";
import {
  cancelRagTaskRequest,
  deleteRagDocuments,
  getRagPipelineStatus,
  getRagReadiness,
  getRagTask,
  importRagDocumentRequest,
  listRagDocuments,
  retrieveRag,
  retryRagTaskRequest,
} from "../services/ragApi";

type UseRagWorkspaceOptions = {
  setStatusMessage: (message: string) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useRagWorkspace({ setStatusMessage }: UseRagWorkspaceOptions) {
  const ragApi = DEFAULT_RAG_API;
  const [ragHealthy, setRagHealthy] = useState<boolean | null>(null);
  const [readiness, setReadiness] = useState<RagReadinessReport | null>(null);
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [documentsTotal, setDocumentsTotal] = useState(0);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState<RagPipelineStatus | null>(null);
  const [retrievalResult, setRetrievalResult] = useState<RagRetrievalResponse | null>(null);
  const [retrievalLoading, setRetrievalLoading] = useState(false);
  const [processingProfile, setProcessingProfile] = useState<ProcessingProfile>("text");
  const [ragTaskId, setRagTaskId] = useState<string | null>(null);
  const [ragTask, setRagTask] = useState<RagTaskStatusResponse | null>(null);

  const selectedProfile = useMemo(
    () => RAG_PROFILES.find((profile) => profile.value === processingProfile) ?? RAG_PROFILES[0],
    [processingProfile],
  );

  const refreshRagHealth = useCallback(async () => {
    try {
      const response = await getRagReadiness(ragApi);
      setReadiness(response.report);
      setRagHealthy(response.ok);
    } catch (error) {
      setReadiness({ status: "offline", detail: errorMessage(error) });
      setRagHealthy(false);
    }
  }, [ragApi]);

  const refreshDocuments = useCallback(async () => {
    setDocumentsLoading(true);
    try {
      const response = await listRagDocuments(ragApi);
      setDocuments(response.documents ?? []);
      setDocumentsTotal(response.total_count ?? response.total ?? response.documents?.length ?? 0);
    } catch (error) {
      setStatusMessage(errorMessage(error));
    } finally {
      setDocumentsLoading(false);
    }
  }, [ragApi, setStatusMessage]);

  const refreshPipeline = useCallback(async () => {
    try {
      setPipelineStatus(await getRagPipelineStatus(ragApi));
    } catch (error) {
      setPipelineStatus(null);
      setStatusMessage(errorMessage(error));
    }
  }, [ragApi, setStatusMessage]);

  const refreshRagTask = useCallback(async (taskId: string) => {
    try {
      const response = await getRagTask(ragApi, taskId);
      setRagTask(response);
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  }, [ragApi, setStatusMessage]);

  useEffect(() => {
    void refreshRagHealth();
    void refreshDocuments();
    void refreshPipeline();
  }, [refreshDocuments, refreshPipeline, refreshRagHealth]);

  useEffect(() => {
    if (!ragTaskId) {
      return undefined;
    }
    if (ragTask && RAG_TASK_TERMINAL_STATUSES.has(ragTask.task.status)) {
      return undefined;
    }
    void refreshRagTask(ragTaskId);
    const timer = window.setInterval(() => void refreshRagTask(ragTaskId), 1_500);
    return () => window.clearInterval(timer);
  }, [ragTask, ragTaskId, refreshRagTask]);

  const importRagDocument = async () => {
    if (!window.desktop) {
      setStatusMessage("RAG 导入仅可在 Electron 桌面进程中执行");
      return;
    }
    try {
      const staged = await window.desktop.stageRagFile();
      if (!staged) {
        return;
      }
      const response = await importRagDocumentRequest(ragApi, staged.gatewayPath, processingProfile);
      setStatusMessage(
        response.task_id
          ? `已提交${selectedProfile.label} profile 导入任务 ${response.task_id}`
          : `导入状态（${selectedProfile.label}）：${response.disposition}`,
      );
      if (response.task_id) {
        setRagTaskId(response.task_id);
        setRagTask(null);
        void refreshRagTask(response.task_id);
        void refreshDocuments();
      }
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  };

  const removeDocuments = async (documentIds: string[]) => {
    if (documentIds.length === 0) return;
    try {
      const response = await deleteRagDocuments(ragApi, documentIds);
      setStatusMessage(`已提交 ${response.tasks.length} 个文档删除任务`);
      await refreshDocuments();
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  };

  const cancelTask = async (taskId: string) => {
    try {
      await cancelRagTaskRequest(ragApi, taskId);
      setStatusMessage("已请求取消 RAG 任务");
      await refreshRagTask(taskId);
      await refreshDocuments();
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  };

  const runRetrieval = async (query: string) => {
    const normalized = query.trim();
    if (normalized.length < 3) {
      setStatusMessage("检索内容至少需要 3 个字符");
      return;
    }
    setRetrievalLoading(true);
    try {
      setRetrievalResult(await retrieveRag(ragApi, normalized));
    } catch (error) {
      setStatusMessage(errorMessage(error));
      setRetrievalResult(null);
    } finally {
      setRetrievalLoading(false);
    }
  };

  const retryRagTask = async () => {
    if (!ragTaskId) {
      return;
    }
    try {
      await retryRagTaskRequest(ragApi, ragTaskId);
      setStatusMessage("已重新提交 RAG 任务");
      setRagTask(null);
      await refreshRagTask(ragTaskId);
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  };

  return {
    ragApi,
    ragHealthy,
    readiness,
    documents,
    documentsTotal,
    documentsLoading,
    pipelineStatus,
    retrievalResult,
    retrievalLoading,
    processingProfile,
    selectedProfile,
    ragTask,
    setProcessingProfile,
    refreshRagHealth,
    refreshDocuments,
    refreshPipeline,
    importRagDocument,
    retryRagTask,
    removeDocuments,
    cancelTask,
    runRetrieval,
    setRetrievalResult,
  };
}
