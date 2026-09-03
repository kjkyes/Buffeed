import ELK from "elkjs/lib/elk.bundled.js";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";

import type { ExecutionIR, ExecutionIRNode } from "../domains/teamScene";

type TeamFlowNodeData = {
  node: ExecutionIRNode;
  muted: boolean;
};

type TeamFlowNode = Node<TeamFlowNodeData, "team">;
type TeamFlowEdge = Edge<{ kind: string }>;

const elk = new ELK();
const NODE_HEIGHT = 86;
const NODE_WIDTHS: Record<ExecutionIRNode["kind"], number> = {
  member: 224,
  task: 334,
};

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    running: "运行中",
    working: "处理中",
    in_progress: "进行中",
    pending: "等待中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    idle: "空闲",
  };
  return labels[status] ?? status;
}

function taskOwner(owner: string | null | undefined): string {
  return owner === "agent" || !owner ? "lead" : owner;
}

function TeamFlowNodeView({ data, selected }: NodeProps<TeamFlowNode>) {
  const { node, muted } = data;
  return (
    <button
      type="button"
      className={`team-flow-node ${node.kind}-node status-${node.status}${selected ? " is-selected" : ""}${muted ? " is-muted" : ""}`}
      title={node.description || node.summary || node.error || node.label}
      aria-label={`${node.kind === "member" ? "成员" : "任务"} ${node.label}`}
      aria-pressed={selected}
    >
      <Handle type="target" position={Position.Left} className="team-flow-handle" />
      <div className="team-node-title">
        <strong>{node.label}</strong>
        <span className="team-status">{statusLabel(node.status)}</span>
      </div>
      {node.kind === "member" ? (
        <>
          <small>{node.role}{node.taskId ? ` · ${node.taskId}` : ""}</small>
          {node.phase && <small>{node.phase}{node.toolName ? ` · ${node.toolName}` : ""}{node.durationMs ? ` · ${node.durationMs} ms` : ""}</small>}
          {node.summary && <small className="team-node-summary">{node.summary}</small>}
          {node.error && <small className="team-node-error">{node.errorCode ? `${node.errorCode}: ` : ""}{node.error}</small>}
        </>
      ) : (
        <>
          <small>{node.taskId} · {taskOwner(node.owner)}</small>
          {node.dependsOn && node.dependsOn.length > 0 && <small>依赖 {node.dependsOn.join(", ")}</small>}
          {node.description && <small className="team-node-summary">{node.description}</small>}
        </>
      )}
      <Handle type="source" position={Position.Right} className="team-flow-handle" />
    </button>
  );
}

const nodeTypes = { team: TeamFlowNodeView };

function edgeStyle(kind: string): { stroke: string; strokeDasharray?: string } {
  if (kind === "owner") {
    return { stroke: "#6aa99b" };
  }
  if (kind === "dependency" || kind === "depends_on") {
    return { stroke: "#b8aaa0", strokeDasharray: "4 4" };
  }
  if (kind === "delegate") {
    return { stroke: "#5b8fd1" };
  }
  if (kind === "continuation") {
    return { stroke: "#9a78c2", strokeDasharray: "2 3" };
  }
  if (kind === "execution-flow") {
    return { stroke: "#d18b4c", strokeDasharray: "7 3" };
  }
  return { stroke: "#87939a", strokeDasharray: "1 4" };
}

function buildElkGraph(execution: ExecutionIR, nodeIds: Set<string>): Parameters<typeof elk.layout>[0] {
  const nodes = execution.nodes.filter((node) => nodeIds.has(node.id));
  const edges = execution.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return {
    id: `team-${execution.executionId}`,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.layered.spacing.edgeNodeBetweenLayers": "28",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTHS[node.kind],
      height: NODE_HEIGHT,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
}

async function layoutExecution(execution: ExecutionIR, nodeIds: Set<string>): Promise<Map<string, { x: number; y: number }>> {
  const graph = await elk.layout(buildElkGraph(execution, nodeIds));
  return new Map((graph.children ?? []).map((node) => [
    node.id,
    { x: node.x ?? 0, y: node.y ?? 0 },
  ]));
}

export function TeamGraphCanvas({
  execution,
  visibleNodeIds,
  selectedNodeId,
  onSelect,
}: {
  execution: ExecutionIR;
  visibleNodeIds: ReadonlySet<string>;
  selectedNodeId: string | null;
  onSelect: (nodeId: string | null) => void;
}) {
  const visibleNodeKey = [...visibleNodeIds].sort().join("|");
  const visibleNodes = useMemo(
    () => execution.nodes.filter((node) => visibleNodeIds.has(node.id)),
    [execution, visibleNodeKey],
  );
  const visibleEdges = useMemo(
    () => execution.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [execution, visibleNodeKey],
  );
  const graphStructureKey = useMemo(
    () => [
      execution.executionId,
      visibleNodeKey,
      visibleEdges.map((edge) => `${edge.id}:${edge.source}:${edge.target}`).sort().join(","),
    ].join("|")
    , [execution.executionId, visibleNodeKey, visibleEdges],
  );
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(() => new Map());
  const [isLayoutting, setIsLayoutting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLayoutting(true);
    void layoutExecution(execution, new Set(visibleNodeIds))
      .then((nextPositions) => {
        if (!cancelled) {
          setPositions(nextPositions);
          setIsLayoutting(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPositions(new Map());
          setIsLayoutting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [graphStructureKey]);

  const relatedNodeIds = useMemo(() => {
    const related = new Set<string>();
    if (!selectedNodeId) {
      return related;
    }
    related.add(selectedNodeId);
    visibleEdges.forEach((edge) => {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        related.add(edge.source);
        related.add(edge.target);
      }
    });
    return related;
  }, [selectedNodeId, visibleEdges]);

  const nodes = useMemo<TeamFlowNode[]>(
    () => visibleNodes.map((node, index) => ({
      id: node.id,
      type: "team",
      position: positions.get(node.id) ?? { x: 24, y: 24 + index * (NODE_HEIGHT + 20) },
      data: {
        node,
        muted: Boolean(selectedNodeId && !relatedNodeIds.has(node.id)),
      },
      style: {
        width: NODE_WIDTHS[node.kind],
        height: NODE_HEIGHT,
      },
      width: NODE_WIDTHS[node.kind],
      height: NODE_HEIGHT,
      draggable: false,
      selectable: true,
      connectable: false,
    })),
    [visibleNodes, positions, selectedNodeId, relatedNodeIds],
  );

  const edges = useMemo<TeamFlowEdge[]>(
    () => visibleEdges.map((edge) => {
      const style = edgeStyle(edge.kind);
      const related = !selectedNodeId || edge.source === selectedNodeId || edge.target === selectedNodeId;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        label: edge.label,
        data: { kind: edge.kind },
        style: {
          ...style,
          strokeWidth: related ? 1.8 : 1.2,
          opacity: related ? 1 : 0.2,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: style.stroke,
          width: 14,
          height: 14,
        },
        selectable: false,
        focusable: false,
      };
    }),
    [visibleEdges, selectedNodeId],
  );

  return (
    <div className="team-flow-canvas" aria-label="Team 执行关系图">
      <ReactFlow
        key={`${execution.executionId}:${visibleNodeKey}:${positions.size}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.35, maxZoom: 1.25 }}
        minZoom={0.3}
        maxZoom={2.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        panOnScroll
        zoomOnScroll
        zoomOnPinch
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
        aria-label="Team 执行关系图"
      >
        <Background color="#d8e5e1" gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
        {isLayoutting && <div className="team-flow-layout-status">布局更新中</div>}
      </ReactFlow>
    </div>
  );
}
