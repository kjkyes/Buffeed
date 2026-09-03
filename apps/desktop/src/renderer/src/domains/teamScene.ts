import type { TeamEdge, TeamObservation } from "./team";

export type ExecutionIRNodeKind = "member" | "task";

export type ExecutionIRNode = {
  id: string;
  kind: ExecutionIRNodeKind;
  label: string;
  status: string;
  role?: string;
  taskId?: string | null;
  owner?: string | null;
  description?: string;
  dependsOn?: string[];
  phase?: string;
  toolName?: string;
  summary?: string;
  durationMs?: number;
  errorCode?: string;
  error?: string;
};

export type ExecutionIREdge = {
  id: string;
  source: string;
  target: string;
  kind: TeamEdge["kind"];
  label?: string;
};

export type ExecutionIR = {
  executionId: string;
  turnId: string | null;
  nodes: ExecutionIRNode[];
  edges: ExecutionIREdge[];
  warnings: string[];
};

export type GraphSceneNode = ExecutionIRNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GraphSceneEdge = ExecutionIREdge & {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  direction: "forward" | "reverse" | "same-layer";
};

export type GraphScene = {
  executionId: string;
  turnId: string | null;
  width: number;
  height: number;
  nodes: GraphSceneNode[];
  edges: GraphSceneEdge[];
  warnings: string[];
};

const NODE_HEIGHT = 64;
const ROW_GAP = 18;
const TOP_PADDING = 22;
const COLUMN_GAP = 78;
const NODE_GAP = 18;
const MIN_SCENE_WIDTH = 760;
const MEMBER_WIDTH = 224;
const TASK_WIDTH = 334;

function nodeId(kind: ExecutionIRNodeKind, value: string): string {
  return `${kind}:${value}`;
}

function memberIdentity(member: { run_id: string; name: string }): string[] {
  return [member.run_id, member.name];
}

function taskIdentity(taskId: string): string[] {
  return [taskId, nodeId("task", taskId)];
}

function edgeKind(edge: TeamEdge): TeamEdge["kind"] {
  return edge.kind === "depends_on" ? "dependency" : edge.kind;
}

/** Convert the durable observation DTO into a renderer-independent execution graph. */
export function buildExecutionIR(observation: TeamObservation | null): ExecutionIR | null {
  if (!observation?.available) {
    return null;
  }

  const nodes: ExecutionIRNode[] = [
    ...observation.members.map((member) => ({
      id: nodeId("member", member.run_id),
      kind: "member" as const,
      label: member.name,
      status: member.status,
      role: member.role,
      taskId: member.task_id,
      phase: member.phase,
      toolName: member.tool_name,
      summary: member.summary,
      durationMs: member.duration_ms,
      errorCode: member.error_code,
      error: member.error,
    })),
    ...observation.tasks.map((task) => ({
      id: nodeId("task", task.task_id),
      kind: "task" as const,
      label: task.subject,
      status: task.status,
      taskId: task.task_id,
      owner: task.owner ?? task.assignee ?? task.assigned_run_id ?? null,
      description: task.description,
      dependsOn: task.depends_on,
    })),
  ];

  const memberByIdentity = new Map<string, string>();
  observation.members.forEach((member) => {
    memberIdentity(member).forEach((identity) => memberByIdentity.set(identity, nodeId("member", member.run_id)));
  });

  const edgesById = new Map<string, ExecutionIREdge>();
  const nodeByIdentity = new Map<string, string>();
  observation.members.forEach((member) => {
    const id = nodeId("member", member.run_id);
    memberIdentity(member).forEach((identity) => nodeByIdentity.set(identity, id));
  });
  observation.tasks.forEach((task) => {
    const id = nodeId("task", task.task_id);
    taskIdentity(task.task_id).forEach((identity) => nodeByIdentity.set(identity, id));
  });

  const addEdge = (source: string | undefined, target: string | undefined, kind: TeamEdge["kind"], label?: string) => {
    if (!source || !target || source === target) {
      return;
    }
    const edge: ExecutionIREdge = {
      id: `${kind}:${source}:${target}`,
      source,
      target,
      kind,
      ...(label ? { label } : {}),
    };
    edgesById.set(edge.id, edge);
  };

  observation.tasks.forEach((task) => {
    const ownerIdentity = task.owner === "agent" || (!task.owner && !task.assignee && !task.assigned_run_id)
      ? "lead"
      : task.owner ?? task.assignee ?? task.assigned_run_id ?? "lead";
    const owner = memberByIdentity.get(ownerIdentity);
    if (owner) {
      addEdge(owner, nodeId("task", task.task_id), "owner");
    }
  });

  observation.edges.forEach((edge) => {
    addEdge(
      nodeByIdentity.get(edge.source),
      nodeByIdentity.get(edge.target),
      edgeKind(edge),
      edge.label,
    );
  });

  return {
    executionId: observation.execution_id,
    turnId: observation.turn_id,
    nodes,
    edges: [...edgesById.values()],
    warnings: observation.warnings,
  };
}

function nodeY(index: number): number {
  return TOP_PADDING + index * (NODE_HEIGHT + NODE_GAP);
}

function fallbackLayer(node: ExecutionIRNode): number {
  return node.kind === "member" ? 0 : 1;
}

function buildIncomingEdges(execution: ExecutionIR): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  execution.nodes.forEach((node) => incoming.set(node.id, []));
  execution.edges.forEach((edge) => {
    const sources = incoming.get(edge.target);
    if (sources && !sources.includes(edge.source)) {
      sources.push(edge.source);
    }
  });
  return incoming;
}

function buildLayers(execution: ExecutionIR): Map<string, number> {
  const incoming = buildIncomingEdges(execution);
  const nodeById = new Map(execution.nodes.map((node) => [node.id, node] as const));
  const layers = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (nodeId: string): number => {
    const cached = layers.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    const node = nodeById.get(nodeId);
    if (!node || visiting.has(nodeId)) {
      return node ? fallbackLayer(node) : 0;
    }
    visiting.add(nodeId);
    const predecessorLayers = (incoming.get(nodeId) ?? [])
      .filter((source) => source !== nodeId)
      .map((source) => resolve(source) + 1);
    visiting.delete(nodeId);
    const layer = Math.max(fallbackLayer(node), ...predecessorLayers, 0);
    layers.set(nodeId, layer);
    return layer;
  };

  execution.nodes.forEach((node) => resolve(node.id));
  return layers;
}

function nodeWidth(node: ExecutionIRNode): number {
  return node.kind === "member" ? MEMBER_WIDTH : TASK_WIDTH;
}

function orderLayer(nodes: ExecutionIRNode[], layer: number, layers: Map<string, number>, positions: Map<string, number>, execution: ExecutionIR): ExecutionIRNode[] {
  const originalOrder = new Map(nodes.map((node, index) => [node.id, index] as const));
  const predecessors = new Map<string, number[]>();
  execution.edges.forEach((edge) => {
    if (layers.get(edge.target) !== layer || layers.get(edge.source) === undefined) {
      return;
    }
    const values = predecessors.get(edge.target) ?? [];
    const position = positions.get(edge.source);
    if (position !== undefined) {
      values.push(position);
    }
    predecessors.set(edge.target, values);
  });
  return [...nodes].sort((left, right) => {
    const leftValues = predecessors.get(left.id) ?? [];
    const rightValues = predecessors.get(right.id) ?? [];
    const leftCenter = leftValues.length ? leftValues.reduce((sum, value) => sum + value, 0) / leftValues.length : Number.POSITIVE_INFINITY;
    const rightCenter = rightValues.length ? rightValues.reduce((sum, value) => sum + value, 0) / rightValues.length : Number.POSITIVE_INFINITY;
    return leftCenter - rightCenter || (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0);
  });
}

/** Apply a deterministic layered layout while keeping the graph renderer-independent. */
export function buildGraphScene(execution: ExecutionIR): GraphScene {
  const layers = buildLayers(execution);
  const layerIds = [...new Set(execution.nodes.map((node) => layers.get(node.id) ?? fallbackLayer(node)))].sort((left, right) => left - right);
  const nodesByLayer = new Map<number, ExecutionIRNode[]>();
  execution.nodes.forEach((node) => {
    const layer = layers.get(node.id) ?? fallbackLayer(node);
    const nodes = nodesByLayer.get(layer) ?? [];
    nodes.push(node);
    nodesByLayer.set(layer, nodes);
  });
  const positions = new Map<string, GraphSceneNode>();
  const previousPositions = new Map<string, number>();
  let currentX = TOP_PADDING;
  layerIds.forEach((layer) => {
    const layerNodes = nodesByLayer.get(layer) ?? [];
    const orderedNodes = orderLayer(layerNodes, layer, layers, previousPositions, execution);
    const width = Math.max(...orderedNodes.map(nodeWidth), MEMBER_WIDTH);
    orderedNodes.forEach((node, index) => {
      previousPositions.set(node.id, index);
      positions.set(node.id, {
        ...node,
        x: currentX,
        y: nodeY(index),
        width: nodeWidth(node),
        height: NODE_HEIGHT,
      });
    });
    currentX += width + COLUMN_GAP;
  });
  const maxRows = Math.max(...[...nodesByLayer.values()].map((nodes) => nodes.length), 1);
  const height = Math.max(220, TOP_PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * NODE_GAP);
  const width = Math.max(MIN_SCENE_WIDTH, currentX - COLUMN_GAP + TOP_PADDING);

  const edges = execution.edges.flatMap<GraphSceneEdge>((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) {
      return [];
    }
    const direction = source.x < target.x ? "forward" : source.x > target.x ? "reverse" : "same-layer";
    const sourceOnRight = direction !== "reverse";
    const targetOnLeft = direction === "forward";
    return [{
      ...edge,
      sourceX: sourceOnRight ? source.x + source.width : source.x,
      sourceY: source.y + source.height / 2,
      targetX: targetOnLeft ? target.x : target.x + target.width,
      targetY: target.y + target.height / 2,
      direction,
    }];
  });

  return {
    ...execution,
    width,
    height,
    nodes: [...positions.values()],
    edges,
  };
}
