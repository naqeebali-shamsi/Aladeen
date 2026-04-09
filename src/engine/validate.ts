import { Blueprint, BlueprintSchema } from './types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a blueprint definition: Zod schema parse, structural consistency,
 * and DAG cycle detection.
 */
export function validateBlueprint(blueprint: Blueprint): ValidationResult {
  const errors: string[] = [];

  // 1. Zod schema validation
  const parsed = BlueprintSchema.safeParse(blueprint);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`Schema: ${issue.path.join('.')} - ${issue.message}`);
    }
    // If schema fails, structural checks would be unreliable
    return { valid: false, errors };
  }

  const nodeIds = new Set(blueprint.nodes.map((n) => n.id));

  // 2. Check for duplicate node IDs
  if (nodeIds.size !== blueprint.nodes.length) {
    const seen = new Set<string>();
    for (const node of blueprint.nodes) {
      if (seen.has(node.id)) {
        errors.push(`Duplicate node id: "${node.id}"`);
      }
      seen.add(node.id);
    }
  }

  // 3. Validate entryNodeId exists
  if (!nodeIds.has(blueprint.entryNodeId)) {
    errors.push(`entryNodeId "${blueprint.entryNodeId}" does not match any node`);
  }

  // 4. Validate edge references
  for (const edge of blueprint.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push(`Edge references unknown source node: "${edge.from}"`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`Edge references unknown target node: "${edge.to}"`);
    }
  }

  // 5. Check for unreachable nodes (not reachable from entryNodeId)
  const reachable = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of blueprint.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)!.push(edge.to);
  }
  const queue = [blueprint.entryNodeId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      queue.push(neighbor);
    }
  }
  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      errors.push(`Node "${nodeId}" is unreachable from entry node "${blueprint.entryNodeId}"`);
    }
  }

  // 6. Cycle detection on the SUCCESS-only subgraph.
  // The full graph may have cycles (e.g., lint -> fix -> lint retry loops), which
  // are valid and bounded by maxRetries at runtime. However, the success-only path
  // must be a DAG to guarantee forward progress.
  const successAdjacency = new Map<string, string[]>();
  for (const edge of blueprint.edges) {
    if (edge.on === undefined || edge.on === 'success') {
      if (!successAdjacency.has(edge.from)) successAdjacency.set(edge.from, []);
      successAdjacency.get(edge.from)!.push(edge.to);
    }
  }
  const cycleErrors = detectCycles(nodeIds, successAdjacency);
  errors.push(...cycleErrors);

  // 7. Verify at least one terminal node exists (a node with no outgoing success edges)
  const nodesWithSuccessOut = new Set(
    blueprint.edges
      .filter((e) => e.on === undefined || e.on === 'success')
      .map((e) => e.from)
  );
  const terminalNodes = blueprint.nodes.filter((n) => !nodesWithSuccessOut.has(n.id));
  if (terminalNodes.length === 0) {
    errors.push('Blueprint has no terminal nodes - every node has an outgoing success edge');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Detect cycles in the directed graph using DFS coloring.
 * White (unvisited) -> Gray (in current path) -> Black (fully explored).
 */
function detectCycles(
  nodeIds: Set<string>,
  adjacency: Map<string, string[]>
): string[] {
  const errors: string[] = [];
  const WHITE = 0;
  const color = new Map<string, number>();

  for (const id of nodeIds) color.set(id, WHITE);

  for (const id of nodeIds) {
    if (color.get(id) === WHITE) {
      if (dfsHasCycle(id, adjacency, color)) {
        errors.push(`Cycle detected involving node "${id}"`);
      }
    }
  }

  return errors;
}

function dfsHasCycle(
  node: string,
  adjacency: Map<string, string[]>,
  color: Map<string, number>
): boolean {
  const GRAY = 1, BLACK = 2;
  color.set(node, GRAY);

  for (const neighbor of adjacency.get(node) ?? []) {
    if (color.get(neighbor) === GRAY) return true;
    if (color.get(neighbor) !== BLACK && dfsHasCycle(neighbor, adjacency, color)) {
      return true;
    }
  }

  color.set(node, BLACK);
  return false;
}
