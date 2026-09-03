import { useCallback, useRef, useState } from "react";

import type { StreamEvent } from "../domains/agent";
import { useAgentWorkspace } from "./useAgentWorkspace";
import { useRagWorkspace } from "./useRagWorkspace";
import { useTeamObservation } from "./useTeamObservation";

/** Compose the three renderer domains while keeping event ownership explicit. */
export function useDesktopWorkbench() {
  const [statusMessage, setStatusMessage] = useState("准备连接本机服务");
  const teamEventConsumerRef = useRef<(event: StreamEvent) => void>(() => undefined);
  const forwardTeamEvent = useCallback((event: StreamEvent) => {
    teamEventConsumerRef.current(event);
  }, []);
  const agent = useAgentWorkspace({
    setStatusMessage,
    onTeamEvent: forwardTeamEvent,
  });
  const team = useTeamObservation({
    agentApi: agent.agentApi,
    activeSessionId: agent.activeSessionId,
    activeTurnId: agent.activeTurnId,
  });
  teamEventConsumerRef.current = team.consumeTeamEvent;
  const rag = useRagWorkspace({ setStatusMessage });

  const refreshHealth = useCallback(async () => {
    await Promise.allSettled([
      agent.refreshAgentHealth(),
      rag.refreshRagHealth(),
    ]);
  }, [agent.refreshAgentHealth, rag.refreshRagHealth]);

  return {
    statusMessage,
    agent,
    team,
    rag,
    refreshHealth,
  };
}
