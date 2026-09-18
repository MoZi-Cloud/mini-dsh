/**
 * Bounded deterministic WorkPacket construction (v1.6a §16/§17, F08).
 * {@link buildWorkPacket} reads only the per-item rows the constitution lists
 * — the plan/version identity, the work item objective, the parent phase
 * summary, the blocking-relation receipts, the acceptance criteria with their
 * verification specs (stored, never executed), the version's baseline
 * snapshot, and nothing else: never the Master Plan document, the whole
 * plan.yaml, other phases' work items, the event history, or another
 * transcript. The builder is deterministic — identical rows serialize to
 * identical bytes and an identical {@link WorkPacket.packetHash} — and
 * bounded: the serialized packet must stay under a byte ceiling.
 *
 * Every packet preparation appends the required
 * `project/work-packet-prepared` event carrying the full reconstruction
 * recipe (format/builder versions, identities, ordered reference ids with
 * ordered content hashes, the packet hash), so the model-visible packet can
 * be re-derived from durable state alone: {@link rebuildWorkPacket} re-reads
 * the referenced rows and recomputes the hash, reporting drift per reference
 * when a row changed after the packet was prepared. The recipe is the event —
 * no materialized packet table exists, because a packet is rebuildable, not
 * source-of-truth. Explicitly associated project memory refs (§17) have no
 * durable home in this build, so the v1 packet records none; when a memory
 * capability lands, its references must be durable rows this rebuild can
 * re-read.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/work-packet
 */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type {
  AcceptanceCriterionId,
  PlanVersionId,
  ProjectId,
  VerifierSpecId,
  WorkItemId,
  WorkItemRelationId,
} from './plan-compile.js'
import type {
  PlanAcceptanceKind,
  PlanExecutorKind,
  PlanRelationKind,
  PlanWorkItemStatus,
  PlanWorkItemType,
} from './plan-document.js'
import {
  appendProjectEvent,
  decodeWorkPacketPreparedPayload,
  nextProjectEventSequence,
  readWorkPacketEvent,
  type AcceptanceCriterionStatus,
  type ReplayedWorkPacket,
  type WorkPacketReferenceKind,
} from './project-events.js'

/** Identity of one prepared work packet (`wp:<workItemId>:<sequence>`). */
export type WorkPacketId = Branded<'WorkPacketId'>

/** Writer identity recorded on packet events by default. */
export const DEFAULT_PACKET_ACTOR_REF = 'dsh-experimental-project-ledger/work-packet'

/** Format version of the packet recipe this builder records. */
export const WORK_PACKET_FORMAT_VERSION = 1

/** Version of the deterministic builder itself. */
export const WORK_PACKET_BUILDER_VERSION = '1'

/**
 * Default byte ceiling for {@link serializeWorkPacket} output. A packet
 * enters a model request, so its serialization must stay bounded even though
 * the rows it reads are per-item; the build refuses to record an unbounded
 * packet instead of truncating silently.
 */
export const WORK_PACKET_MAX_SERIALIZED_BYTES = 65_536

/** Closed set of work-packet rejection reasons. */
export type WorkPacketErrorCode =
  | 'unknown-work-item'
  | 'work-item-unplanned'
  | 'invalid-packet-config'
  | 'packet-too-large'
  | 'unknown-work-packet'

/**
 * Thrown by the packet seams. Build rejections write nothing (the
 * transaction rolls back); rebuild rejections read nothing past the failure.
 */
export class WorkPacketError extends Error {
  /** Why the packet request was rejected. */
  readonly code: WorkPacketErrorCode

  /** @param code - why the request was rejected. @param message - the concrete reason. */
  constructor(code: WorkPacketErrorCode, message: string) {
    super(message)
    this.name = 'WorkPacketError'
    this.code = code
  }
}

/** The immutable plan/version identity a packet carries. */
export interface WorkPacketPlanIdentity {
  readonly planId: string
  readonly planName: string
  readonly versionNo: number
  readonly sourceDocumentHash: string
  readonly compiledIrHash: string
}

/** The version's pinned baseline; a version without one records `null` fields. */
export interface WorkPacketRepoSnapshot {
  readonly repoHead: string | null
  readonly worktreeHash: string | null
}

/** The work item objective §17 names as the packet's task statement. */
export interface WorkPacketObjective {
  readonly stableKey: string
  readonly workType: PlanWorkItemType
  readonly executorKind: PlanExecutorKind
  readonly title: string
  readonly description: string | null
}

/** The parent phase summary; a phase-less item records `null`. */
export interface WorkPacketPhaseSummary {
  readonly phaseId: string
  readonly stableKey: string
  readonly title: string
  readonly description: string | null
}

/** One incoming ordering edge with the source item's status at preparation time. */
export interface WorkPacketRelationReceipt {
  readonly relationId: WorkItemRelationId
  readonly fromWorkItemId: WorkItemId
  readonly relationKind: PlanRelationKind
  readonly fromStatus: PlanWorkItemStatus
}

/** One acceptance criterion with its current projection status. */
export interface WorkPacketCriterion {
  readonly criterionId: AcceptanceCriterionId
  readonly ordinal: number
  readonly criterionKind: PlanAcceptanceKind
  readonly description: string
  readonly required: boolean
  readonly status: AcceptanceCriterionStatus
}

/** One verification spec exactly as stored; nothing here is ever executed. */
export interface WorkPacketVerifierSpec {
  readonly specId: VerifierSpecId
  readonly criterionId: AcceptanceCriterionId
  readonly verifierKind: PlanAcceptanceKind
  readonly commandText: string | null
  readonly expectedExitCode: number | null
  readonly queryText: string | null
  readonly expectedJson: string | null
  readonly ownerInstruction: string | null
  readonly sandboxRequired: boolean
  readonly approvalRequired: boolean
}

/** One ordered recipe entry: a reference id and the hash of the section it pins. */
export interface WorkPacketReference {
  readonly kind: WorkPacketReferenceKind
  readonly refId: string
  readonly contentHash: string
}

/**
 * The document fields every serialized packet carries; a prepared
 * {@link WorkPacket} satisfies this shape, and the in-flight compose result
 * satisfies it before its hash exists.
 */
export type WorkPacketDocument = Omit<WorkPacket, 'packetId' | 'sequenceNo' | 'packetHash' | 'serializedBytes'>

/** A prepared work packet: the recipe, the contents it pins, and the hash. */
export interface WorkPacket {
  /** `wp:<workItemId>:<sequence of the prepared event>`. */
  readonly packetId: WorkPacketId
  readonly sequenceNo: number
  readonly packetFormatVersion: number
  readonly builderVersion: string
  readonly workItemId: WorkItemId
  readonly planVersionId: PlanVersionId
  readonly repoSnapshotId: string
  /** Ordered recipe entries; each content hash covers exactly the section the serialized document carries. */
  readonly references: readonly WorkPacketReference[]
  readonly plan: WorkPacketPlanIdentity
  readonly repoSnapshot: WorkPacketRepoSnapshot
  readonly objective: WorkPacketObjective
  readonly phase: WorkPacketPhaseSummary | null
  readonly relationReceipts: readonly WorkPacketRelationReceipt[]
  readonly acceptance: readonly WorkPacketCriterion[]
  readonly verifierSpecs: readonly WorkPacketVerifierSpec[]
  /** SHA-256 of the canonical JSON of the recipe (identity fields plus ordered references). */
  readonly packetHash: string
  readonly serializedBytes: number
}

/** Options for {@link buildWorkPacket}. */
export interface BuildWorkPacketOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_PACKET_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the event; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
  /** Serialized-packet byte ceiling; defaults to {@link WORK_PACKET_MAX_SERIALIZED_BYTES}. */
  readonly maxSerializedBytes?: number | undefined
}

/** The rebuild outcome of one recorded packet against the current rows. */
export interface WorkPacketRebuild {
  readonly packetId: WorkPacketId
  readonly sequenceNo: number
  /** The recipe exactly as the event recorded it. */
  readonly recorded: ReplayedWorkPacket
  /** The packet recomposed from current rows, pinned to the recorded id and sequence. */
  readonly packet: WorkPacket
  /** `true` exactly when the recomposed recipe hashes to the recorded packet hash. */
  readonly matchesRecordedHash: boolean
  /** Recorded references whose current content hash differs or whose row is gone; additions surface through the hash mismatch. */
  readonly driftedReferenceIds: readonly string[]
}

/** The `work_items` row fields the packet reads, in select order. */
interface WorkItemPacketRow {
  readonly project_id: string
  readonly plan_version_id: string | null
  readonly phase_id: string | null
  readonly stable_key: string
  readonly work_type: PlanWorkItemType
  readonly executor_kind: PlanExecutorKind
  readonly title: string
  readonly description: string | null
}

/** The `work_items` row fields the packet reads once the unplanned guard has passed. */
type VersionedWorkItemPacketRow = WorkItemPacketRow & { plan_version_id: string }

/**
 * Read the `work_items` row a packet is built from. An unrecorded item fails
 * loud; a version-less item fails loud too, because the v1 packet reads the
 * plan identity, baseline, and acceptance rows a plan version owns.
 */
function readWorkItemPacketRow(db: DatabaseSync, workItemId: WorkItemId): VersionedWorkItemPacketRow {
  const item = db
    .prepare(
      'SELECT project_id, plan_version_id, phase_id, stable_key, work_type, executor_kind, title, description '
      + 'FROM work_items WHERE id = ?',
    )
    .get(workItemId) as WorkItemPacketRow | undefined
  if (item === undefined) {
    throw new WorkPacketError(
      'unknown-work-item',
      `work item "${workItemId}" is not recorded in this ledger`,
    )
  }
  if (item.plan_version_id === null) {
    throw new WorkPacketError(
      'work-item-unplanned',
      `work item "${workItemId}" records no plan version; the v1 packet reads the plan identity, `
        + 'baseline snapshot, and acceptance rows a plan version owns',
    )
  }
  return item as VersionedWorkItemPacketRow
}

/** The packet identity a compose run pins: the id and the recorded sequence. */
interface PacketIdentity {
  readonly packetId: WorkPacketId
  readonly sequenceNo: number
}

/**
 * Compose a packet from the current rows: read the §17 inputs, hash each
 * section, hash the recipe, and enforce the serialized byte ceiling. Both
 * {@link buildWorkPacket} and {@link rebuildWorkPacket} route through here,
 * which is what makes the rebuild bit-identical on unchanged rows.
 * @param db - open ledger database.
 * @param item - the work item row, already read by the caller inside its transaction.
 * @param workItemId - the branded id of {@link item}.
 * @param identity - the packet id and sequence to stamp.
 * @param maxSerializedBytes - byte ceiling; {@link Number.POSITIVE_INFINITY} skips the check (drift reporting, not enforcement).
 * @returns the composed packet.
 * @throws {WorkPacketError} on `packet-too-large`.
 */
function composeWorkPacket(
  db: DatabaseSync,
  item: VersionedWorkItemPacketRow,
  workItemId: WorkItemId,
  identity: PacketIdentity,
  maxSerializedBytes: number,
): WorkPacket {
  const version = db.prepare(
    'SELECT v.plan_id AS plan_id, v.version_no AS version_no, v.baseline_repo_head AS repo_head, '
    + 'v.baseline_worktree_hash AS worktree_hash, v.source_document_hash AS source_document_hash, '
    + 'v.compiled_ir_hash AS compiled_ir_hash, p.name AS plan_name '
    + 'FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = ?',
  ).get(item.plan_version_id) as {
    plan_id: string
    version_no: number
    repo_head: string | null
    worktree_hash: string | null
    source_document_hash: string
    compiled_ir_hash: string
    plan_name: string
  }
  const planVersionId = brandString<PlanVersionId>(item.plan_version_id)
  const repoSnapshotId = `rs:${planVersionId}`
  const plan: WorkPacketPlanIdentity = {
    planId: version.plan_id,
    planName: version.plan_name,
    versionNo: version.version_no,
    sourceDocumentHash: version.source_document_hash,
    compiledIrHash: version.compiled_ir_hash,
  }
  const repoSnapshot: WorkPacketRepoSnapshot = { repoHead: version.repo_head, worktreeHash: version.worktree_hash }
  const objective: WorkPacketObjective = {
    stableKey: item.stable_key,
    workType: item.work_type,
    executorKind: item.executor_kind,
    title: item.title,
    description: item.description,
  }
  const phaseRow = item.phase_id === null ? undefined
    : db.prepare('SELECT id, stable_key, title, description FROM phases WHERE id = ?')
      .get(item.phase_id) as { id: string; stable_key: string; title: string; description: string | null }
  const phase: WorkPacketPhaseSummary | null = phaseRow === undefined ? null : {
    phaseId: phaseRow.id,
    stableKey: phaseRow.stable_key,
    title: phaseRow.title,
    description: phaseRow.description,
  }
  const relationReceipts: WorkPacketRelationReceipt[] = (db.prepare(
    'SELECT r.id AS relation_id, r.from_work_item_id AS from_work_item_id, r.relation_kind AS relation_kind, '
    + 'w.status AS from_status '
    + 'FROM work_item_relations r JOIN work_items w ON w.id = r.from_work_item_id '
    + "WHERE r.to_work_item_id = ? AND r.relation_kind IN ('BLOCKS', 'PRECEDES') ORDER BY r.id",
  ).all(workItemId) as {
    relation_id: string
    from_work_item_id: string
    relation_kind: PlanRelationKind
    from_status: PlanWorkItemStatus
  }[]).map(row => ({
    relationId: brandString<WorkItemRelationId>(row.relation_id),
    fromWorkItemId: brandString<WorkItemId>(row.from_work_item_id),
    relationKind: row.relation_kind,
    fromStatus: row.from_status,
  }))
  const acceptance: WorkPacketCriterion[] = (db.prepare(
    'SELECT id, ordinal, criterion_kind, description, required, status FROM acceptance_criteria '
    + 'WHERE work_item_id = ? ORDER BY ordinal',
  ).all(workItemId) as {
    id: string
    ordinal: number
    criterion_kind: PlanAcceptanceKind
    description: string
    required: number
    status: AcceptanceCriterionStatus
  }[]).map(row => ({
    criterionId: brandString<AcceptanceCriterionId>(row.id),
    ordinal: row.ordinal,
    criterionKind: row.criterion_kind,
    description: row.description,
    required: row.required === 1,
    status: row.status,
  }))
  const verifierSpecs: WorkPacketVerifierSpec[] = (db.prepare(
    'SELECT s.id AS spec_id, s.criterion_id AS criterion_id, s.verifier_kind AS verifier_kind, '
    + 's.command_text AS command_text, s.expected_exit_code AS expected_exit_code, s.query_text AS query_text, '
    + 's.expected_json AS expected_json, s.owner_instruction AS owner_instruction, '
    + 's.sandbox_required AS sandbox_required, s.approval_required AS approval_required '
    + 'FROM verification_specs s JOIN acceptance_criteria c ON c.id = s.criterion_id '
    + 'WHERE c.work_item_id = ? ORDER BY c.ordinal, s.id',
  ).all(workItemId) as {
    spec_id: string
    criterion_id: string
    verifier_kind: PlanAcceptanceKind
    command_text: string | null
    expected_exit_code: number | null
    query_text: string | null
    expected_json: string | null
    owner_instruction: string | null
    sandbox_required: number
    approval_required: number
  }[]).map(row => ({
    specId: brandString<VerifierSpecId>(row.spec_id),
    criterionId: brandString<AcceptanceCriterionId>(row.criterion_id),
    verifierKind: row.verifier_kind,
    commandText: row.command_text,
    expectedExitCode: row.expected_exit_code,
    queryText: row.query_text,
    expectedJson: row.expected_json,
    ownerInstruction: row.owner_instruction,
    sandboxRequired: row.sandbox_required === 1,
    approvalRequired: row.approval_required === 1,
  }))

  const references: WorkPacketReference[] = [
    { kind: 'plan-version', refId: planVersionId, contentHash: contentHash(plan) },
    { kind: 'repo-snapshot', refId: repoSnapshotId, contentHash: contentHash(repoSnapshot) },
    { kind: 'work-item', refId: workItemId, contentHash: contentHash(objective) },
  ]
  if (phase !== null) references.push({ kind: 'phase', refId: phase.phaseId, contentHash: contentHash(phase) })
  for (const receipt of relationReceipts) {
    references.push({ kind: 'blocking-relation', refId: receipt.relationId, contentHash: contentHash(receipt) })
  }
  for (const criterion of acceptance) {
    references.push({ kind: 'acceptance-criterion', refId: criterion.criterionId, contentHash: contentHash(criterion) })
  }
  for (const spec of verifierSpecs) {
    references.push({ kind: 'verification-spec', refId: spec.specId, contentHash: contentHash(spec) })
  }

  const document: WorkPacketDocument = {
    packetFormatVersion: WORK_PACKET_FORMAT_VERSION,
    builderVersion: WORK_PACKET_BUILDER_VERSION,
    workItemId,
    planVersionId,
    repoSnapshotId,
    references,
    plan,
    repoSnapshot,
    objective,
    phase,
    relationReceipts,
    acceptance,
    verifierSpecs,
  }
  const serializedBytes = Buffer.byteLength(serializeWorkPacket(document), 'utf8')
  if (serializedBytes > maxSerializedBytes) {
    throw new WorkPacketError(
      'packet-too-large',
      `the serialized work packet for "${workItemId}" is ${serializedBytes} bytes, above the `
        + `${maxSerializedBytes}-byte bound; a packet must stay bounded for the request lane it enters`,
    )
  }
  return {
    ...document,
    packetId: identity.packetId,
    sequenceNo: identity.sequenceNo,
    packetHash: contentHash(packetRecipe(document)),
    serializedBytes,
  }
}

/** The recipe object {@link WorkPacket.packetHash} covers: identity plus ordered references. */
function packetRecipe(packet: WorkPacketDocument): Record<string, unknown> {
  return {
    packetFormatVersion: packet.packetFormatVersion,
    builderVersion: packet.builderVersion,
    workItemId: packet.workItemId,
    planVersionId: packet.planVersionId,
    repoSnapshotId: packet.repoSnapshotId,
    references: packet.references,
  }
}

/** SHA-256 hex of a value's canonical JSON — fixed key order, compact separators. */
function contentHash(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Serialize a packet into the bounded model-visible document: the recipe
 * followed by the contents it pins, as one canonical JSON text with fixed key
 * order. Identical rows always serialize to identical bytes, which is what
 * the request lane and the rebuild compare.
 * @param packet - the packet to serialize.
 * @returns the canonical JSON document the model request carries.
 */
export function serializeWorkPacket(packet: WorkPacketDocument): string {
  return JSON.stringify({
    packetFormatVersion: packet.packetFormatVersion,
    builderVersion: packet.builderVersion,
    workItemId: packet.workItemId,
    planVersionId: packet.planVersionId,
    repoSnapshotId: packet.repoSnapshotId,
    references: packet.references,
    plan: packet.plan,
    repoSnapshot: packet.repoSnapshot,
    objective: packet.objective,
    phase: packet.phase,
    relationReceipts: packet.relationReceipts,
    acceptance: packet.acceptance,
    verifierSpecs: packet.verifierSpecs,
  })
}

/**
 * Build one work packet and record its recipe (§16): inside a single
 * `BEGIN IMMEDIATE` transaction, read the §17 inputs, hash the recipe, append
 * the required `project/work-packet-prepared` event, and return the packet.
 * The packet id derives from the appended event's sequence. Readiness is not
 * an input here — the claim seam owns it; a packet may be prepared for any
 * versioned item.
 * @param db - open ledger database.
 * @param workItemId - the work item to prepare a packet for.
 * @param options - actor, clock, and byte-ceiling overrides.
 * @returns the prepared packet with its recipe hash and serialized size.
 * @throws {WorkPacketError} on `unknown-work-item`, `work-item-unplanned`,
 * `invalid-packet-config`, and `packet-too-large`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function buildWorkPacket(
  db: DatabaseSync,
  workItemId: WorkItemId,
  options: BuildWorkPacketOptions = {},
): WorkPacket {
  const maxSerializedBytes = options.maxSerializedBytes ?? WORK_PACKET_MAX_SERIALIZED_BYTES
  if (!Number.isInteger(maxSerializedBytes) || maxSerializedBytes <= 0) {
    throw new WorkPacketError(
      'invalid-packet-config',
      `maxSerializedBytes must be a positive integer, got ${maxSerializedBytes}`,
    )
  }
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_PACKET_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const item = readWorkItemPacketRow(db, workItemId)
    const projectId = brandString<ProjectId>(item.project_id)
    // The builder holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the packet id is the prepared event's.
    const sequenceNo = nextProjectEventSequence(db, projectId)
    const packetId = brandString<WorkPacketId>(`wp:${workItemId}:${sequenceNo}`)
    const packet = composeWorkPacket(db, item, workItemId, { packetId, sequenceNo }, maxSerializedBytes)
    appendProjectEvent(
      db,
      projectId,
      'project/work-packet-prepared',
      {
        packetId,
        packetFormatVersion: packet.packetFormatVersion,
        builderVersion: packet.builderVersion,
        workItemId,
        planVersionId: packet.planVersionId,
        repoSnapshotId: packet.repoSnapshotId,
        references: packet.references,
        packetHash: packet.packetHash,
        serializedBytes: packet.serializedBytes,
      },
      { entityType: 'work_packet', entityId: packetId, actorRef, nowMs },
    )
    db.exec('COMMIT')
    return packet
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Rebuild one recorded packet from the current rows and compare it with the
 * recorded recipe. The only inputs are the ledger database and the packet id
 * — never the plan document — so this is the §16 reconstruction proof: on
 * unchanged rows the recomposed hash equals the recorded one, and any row a
 * reference pins that has since moved names its reference as drifted.
 * @param db - open ledger database.
 * @param packetId - the prepared packet to rebuild.
 * @returns the recorded recipe, the recomposed packet, and the drift report.
 * @throws {WorkPacketError} on `unknown-work-packet` and `unknown-work-item`.
 */
export function rebuildWorkPacket(db: DatabaseSync, packetId: WorkPacketId): WorkPacketRebuild {
  const event = readWorkPacketEvent(db, packetId)
  if (event === undefined) {
    throw new WorkPacketError(
      'unknown-work-packet',
      `work packet "${packetId}" is not recorded in this ledger`,
    )
  }
  const recorded = decodeWorkPacketPreparedPayload(event)
  const item = readWorkItemPacketRow(db, recorded.workItemId)
  // The rebuild reports drift instead of enforcing the byte ceiling: rows
  // that grew since preparation are evidence, not an obstruction.
  const packet = composeWorkPacket(
    db,
    item,
    recorded.workItemId,
    { packetId, sequenceNo: event.sequenceNo },
    Number.POSITIVE_INFINITY,
  )
  const currentHashes = new Map(packet.references.map(reference => [reference.refId, reference.contentHash]))
  const driftedReferenceIds = recorded.references
    .filter(reference => currentHashes.get(reference.refId) !== reference.contentHash)
    .map(reference => reference.refId)
  return {
    packetId,
    sequenceNo: event.sequenceNo,
    recorded,
    packet,
    matchesRecordedHash: recorded.packetHash === packet.packetHash,
    driftedReferenceIds,
  }
}
