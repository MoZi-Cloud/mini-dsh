import type { PlanDocumentV1 } from './plan-document.js'
import { type PlanIssue, PlanDocumentError } from './plan-issues.js'

/**
 * Relation kinds that order work and therefore deadlock on a cycle. A
 * `BLOCKS`, `PRECEDES`, or `SUPERSEDES` edge that closes a loop can never be
 * satisfied; `RELATES_TO` and `DUPLICATES` carry no ordering and are excluded.
 */
const ORDERING_RELATION_KINDS: ReadonlySet<string> = new Set(['BLOCKS', 'PRECEDES', 'SUPERSEDES'])

const WalkState = {
  Unvisited: 0,
  InProgress: 1,
  Done: 2,
} as const

/**
 * Check reference integrity and acyclicity of a schema-valid document: every
 * `phaseId`, `parentId`, and relation endpoint must name an existing entity,
 * parent chains and ordering relations must be acyclic, and duplicate
 * identifiers, ordinals, and relations are rejected. Pure; never touches a
 * store and never executes verifier commands.
 *
 * Acceptance `kind` must also agree with its verifier `kind`: the two fields
 * are redundant in the constitution, and a disagreement would silently let a
 * criterion be evaluated under the wrong seam.
 * @param document - a document that passed `validatePlanSchema`.
 * @throws {PlanDocumentError} with every semantic issue and its dotted path.
 */
export function validatePlanSemantics(document: PlanDocumentV1): void {
  const issues: PlanIssue[] = []

  const phaseIndexes = new Map<string, number>()
  const phaseOrdinals = new Map<number, number>()
  document.phases.forEach((phase, index) => {
    const firstAtIndex = phaseIndexes.get(phase.id)
    if (firstAtIndex === undefined) {
      phaseIndexes.set(phase.id, index)
    } else {
      issues.push({
        code: 'duplicate-phase-id',
        message: `phase id '${phase.id}' is already used by phases[${firstAtIndex}]`,
        path: `phases[${index}].id`,
      })
    }
    const firstOrdinalIndex = phaseOrdinals.get(phase.ordinal)
    if (firstOrdinalIndex === undefined) {
      phaseOrdinals.set(phase.ordinal, index)
    } else {
      issues.push({
        code: 'duplicate-phase-ordinal',
        message: `phase ordinal ${phase.ordinal} is already used by phases[${firstOrdinalIndex}]`,
        path: `phases[${index}].ordinal`,
      })
    }
  })

  const workItemIndexes = new Map<string, number>()
  document.workItems.forEach((workItem, index) => {
    const firstAtIndex = workItemIndexes.get(workItem.id)
    if (firstAtIndex === undefined) {
      workItemIndexes.set(workItem.id, index)
    } else {
      issues.push({
        code: 'duplicate-work-item-id',
        message: `work item id '${workItem.id}' is already used by workItems[${firstAtIndex}]`,
        path: `workItems[${index}].id`,
      })
    }
  })

  document.workItems.forEach((workItem, index) => {
    if (workItem.phaseId !== undefined && !phaseIndexes.has(workItem.phaseId)) {
      issues.push({
        code: 'unknown-phase-reference',
        message: `phaseId '${workItem.phaseId}' does not name any phase of this document`,
        path: `workItems[${index}].phaseId`,
      })
    }
    workItem.acceptance.forEach((criterion, criterionIndex) => {
      if (criterion.kind !== criterion.verifier.kind) {
        issues.push({
          code: 'acceptance-verifier-kind-mismatch',
          message: `acceptance kind '${criterion.kind}' does not match verifier kind '${criterion.verifier.kind}'`,
          path: `workItems[${index}].acceptance[${criterionIndex}].kind`,
        })
      }
    })
  })

  collectHierarchyIssues(document, workItemIndexes, issues)
  collectRelationIssues(document, workItemIndexes, issues)

  if (issues.length > 0) {
    throw new PlanDocumentError(issues)
  }
}

/** Check `parentId` references and detect cycles in the parent composition chain. */
function collectHierarchyIssues(
  document: PlanDocumentV1,
  workItemIndexes: Map<string, number>,
  issues: PlanIssue[],
): void {
  const parentOf = new Map<string, string>()
  for (const workItem of document.workItems) {
    if (workItem.parentId === undefined) {
      continue
    }
    const parentIndex = workItemIndexes.get(workItem.parentId)
    if (parentIndex === undefined) {
      issues.push({
        code: 'unknown-parent-reference',
        message: `parentId '${workItem.parentId}' does not name any work item of this document`,
        path: `workItems[${workItemIndexes.get(workItem.id)}].parentId`,
      })
      continue
    }
    parentOf.set(workItem.id, workItem.parentId)
  }

  const state = new Map<string, typeof WalkState[keyof typeof WalkState]>()
  for (const workItem of document.workItems) {
    walkChain(workItem.id, parentOf, state, workItemIndexes, issues)
  }
}

/** Iterative parent-chain walk shared by every start item; emits each cycle once. */
function walkChain(
  startId: string,
  parentOf: Map<string, string>,
  state: Map<string, 0 | 1 | 2>,
  workItemIndexes: Map<string, number>,
  issues: PlanIssue[],
): void {
  if (state.get(startId) === WalkState.Done) {
    return
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
      issues.push({
        code: 'hierarchy-cycle',
        message: `parentId chain forms a cycle: ${cycle.join(' -> ')}`,
        path: `workItems[${workItemIndexes.get(current)}].parentId`,
      })
      break
    }
    state.set(current, WalkState.InProgress)
    chain.push(current)
    const parent = parentOf.get(current)
    if (parent === undefined) {
      break
    }
    current = parent
  }
  for (const id of chain) {
    state.set(id, WalkState.Done)
  }
}

/** Check relation endpoints, self edges, duplicates, and ordering-relation cycles. */
function collectRelationIssues(
  document: PlanDocumentV1,
  workItemIndexes: Map<string, number>,
  issues: PlanIssue[],
): void {
  const seenRelations = new Map<string, number>()
  const edges = new Map<string, { to: string; relationIndex: number }[]>()
  for (const [index, relation] of document.relations.entries()) {
    const fromIndex = workItemIndexes.get(relation.from)
    if (fromIndex === undefined) {
      issues.push({
        code: 'unknown-relation-reference',
        message: `relation 'from' '${relation.from}' does not name any work item of this document`,
        path: `relations[${index}].from`,
      })
    }
    const toIndex = workItemIndexes.get(relation.to)
    if (toIndex === undefined) {
      issues.push({
        code: 'unknown-relation-reference',
        message: `relation 'to' '${relation.to}' does not name any work item of this document`,
        path: `relations[${index}].to`,
      })
    }
    if (relation.from === relation.to) {
      issues.push({
        code: 'self-relation',
        message: `relation '${relation.kind}' cannot start and end at '${relation.from}'`,
        path: `relations[${index}]`,
      })
    }
    const relationKey = `${relation.from}\u0000${relation.to}\u0000${relation.kind}`
    const firstIndex = seenRelations.get(relationKey)
    if (firstIndex === undefined) {
      seenRelations.set(relationKey, index)
    } else {
      issues.push({
        code: 'duplicate-relation',
        message: `relation ${relation.kind} '${relation.from}' -> '${relation.to}' is already declared by relations[${firstIndex}]`,
        path: `relations[${index}]`,
      })
    }
    if (!ORDERING_RELATION_KINDS.has(relation.kind) || relation.from === relation.to) {
      // Self edges are reported once as `self-relation`; they would only
      // duplicate as a length-one relation cycle.
      continue
    }
    const outgoing = edges.get(relation.from) ?? []
    outgoing.push({ to: relation.to, relationIndex: index })
    edges.set(relation.from, outgoing)
  }

  const state = new Map<string, 0 | 1 | 2>()
  for (const relation of document.relations) {
    if (!ORDERING_RELATION_KINDS.has(relation.kind) || state.get(relation.from) === WalkState.Done) {
      continue
    }
    walkOrdering(relation.from, edges, state, issues)
  }
}

/** Depth-first walk over ordering edges; emits the cycle closed by each back edge. */
function walkOrdering(
  startId: string,
  edges: Map<string, { to: string; relationIndex: number }[]>,
  state: Map<string, 0 | 1 | 2>,
  issues: PlanIssue[],
): void {
  const stack: { id: string; outgoing: { to: string; relationIndex: number }[]; next: number }[] = [
    { id: startId, outgoing: edges.get(startId) ?? [], next: 0 },
  ]
  state.set(startId, WalkState.InProgress)
  const chain: string[] = [startId]
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const edge = frame.outgoing[frame.next]
    if (edge === undefined) {
      state.set(frame.id, WalkState.Done)
      chain.pop()
      continue
    }
    frame.next += 1
    stack.push(frame)
    const targetState = state.get(edge.to) ?? WalkState.Unvisited
    if (targetState === WalkState.InProgress) {
      const cycleStart = chain.indexOf(edge.to)
      const cycle = [...chain.slice(cycleStart), edge.to]
      for (const id of cycle) {
        state.set(id, WalkState.Done)
      }
      issues.push({
        code: 'relation-cycle',
        message: `ordering relations form a cycle: ${cycle.join(' -> ')}`,
        path: `relations[${edge.relationIndex}]`,
      })
      continue
    }
    if (targetState === WalkState.Done) {
      continue
    }
    state.set(edge.to, WalkState.InProgress)
    chain.push(edge.to)
    stack.push({ id: edge.to, outgoing: edges.get(edge.to) ?? [], next: 0 })
  }
}
