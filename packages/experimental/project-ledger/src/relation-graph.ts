/**
 * Cycle semantics shared by compile-time plan validation and the ledger-side
 * work-graph checks: the ordering-relation kinds that deadlock on a cycle, and
 * the two walks that report each cycle exactly once. Compile-time validation
 * walks a parsed document (`validatePlanSemantics`); the ledger doctor walks
 * the materialized `work_items` parent chains and `work_item_relations` rows.
 * Both callers must reach the same verdict from the same graph, so the walks
 * live here instead of drifting apart.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/relation-graph
 */

import type { PlanRelationKind } from './plan-document.js'

/**
 * Relation kinds that order work and therefore deadlock on a cycle. A
 * `BLOCKS`, `PRECEDES`, or `SUPERSEDES` edge that closes a loop can never be
 * satisfied; `RELATES_TO` and `DUPLICATES` carry no ordering and are excluded.
 */
export const ORDERING_RELATION_KINDS: ReadonlySet<string> = new Set<string>([
  'BLOCKS',
  'PRECEDES',
  'SUPERSEDES',
] satisfies PlanRelationKind[])

const WalkState = {
  Unvisited: 0,
  InProgress: 1,
  Done: 2,
} as const

/**
 * Find the cycles of a functional graph (every node has at most one successor,
 * such as a parent chain), reporting each cycle once as the closed loop
 * `first -> … -> first`. Pure; the walk order follows `nodes`, so callers
 * control determinism.
 * @param nodes - every node of the graph, in the caller's order.
 * @param nextOf - successor of each node; nodes without an entry are roots.
 * @returns one non-empty closed loop per cycle, in discovery order.
 */
export function findChainCycles(
  nodes: Iterable<string>,
  nextOf: ReadonlyMap<string, string>,
): string[][] {
  const state = new Map<string, typeof WalkState[keyof typeof WalkState]>()
  const cycles: string[][] = []
  for (const startId of nodes) {
    if (state.get(startId) === WalkState.Done) {
      continue
    }
    const chain: string[] = []
    let current = startId
    while (true) {
      const currentState = state.get(current) ?? WalkState.Unvisited
      if (currentState === WalkState.Done) {
        break
      }
      if (currentState === WalkState.InProgress) {
        const cycleStart = chain.indexOf(current)
        const cycle = [...chain.slice(cycleStart), current]
        for (const id of cycle) {
          state.set(id, WalkState.Done)
        }
        cycles.push(cycle)
        break
      }
      state.set(current, WalkState.InProgress)
      chain.push(current)
      const next = nextOf.get(current)
      if (next === undefined) {
        break
      }
      current = next
    }
    for (const id of chain) {
      state.set(id, WalkState.Done)
    }
  }
  return cycles
}

/**
 * Find the cycles of a directed graph, reporting each cycle once as the
 * closed loop `first -> … -> first` whose closing edge is the last node
 * pointing back at the first. Pure; the walk order follows `starts`, so
 * callers control determinism.
 * @param starts - walk roots in the caller's order; every node reachable from
 * an earlier start is already settled, so later starts only walk new subgraphs.
 * @param edgesOf - outgoing edges of one node, in the caller's order.
 * @returns one non-empty closed loop per cycle, in discovery order.
 */
export function findOrderingCycles(
  starts: Iterable<string>,
  edgesOf: (node: string) => readonly string[],
): string[][] {
  const state = new Map<string, typeof WalkState[keyof typeof WalkState]>()
  const cycles: string[][] = []
  for (const startId of starts) {
    if (state.get(startId) === WalkState.Done) {
      continue
    }
    const stack: { id: string; outgoing: readonly string[]; next: number }[] = [
      { id: startId, outgoing: edgesOf(startId), next: 0 },
    ]
    state.set(startId, WalkState.InProgress)
    const chain: string[] = [startId]
    for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
      const target = frame.outgoing[frame.next]
      if (target === undefined) {
        state.set(frame.id, WalkState.Done)
        chain.pop()
        continue
      }
      frame.next += 1
      stack.push(frame)
      const targetState = state.get(target) ?? WalkState.Unvisited
      if (targetState === WalkState.InProgress) {
        const cycleStart = chain.indexOf(target)
        const cycle = [...chain.slice(cycleStart), target]
        for (const id of cycle) {
          state.set(id, WalkState.Done)
        }
        cycles.push(cycle)
        continue
      }
      if (targetState === WalkState.Done) {
        continue
      }
      state.set(target, WalkState.InProgress)
      chain.push(target)
      stack.push({ id: target, outgoing: edgesOf(target), next: 0 })
    }
  }
  return cycles
}
