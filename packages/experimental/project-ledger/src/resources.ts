/**
 * The v1.6b resource domain (proposal "v1.6b — Owner / Decision / Resource
 * Domain", blueprint §25/§26/§27): a project opens resource requirements,
 * instances are provided against them, and each instance is verified PASS
 * or FAIL against a stored spec — the spec is stored data, never executed.
 * {@link openResourceRequirement} records one requirement atomically under
 * a `resource/required` event; {@link provideResourceInstance} records one
 * instance under `resource/provided`; {@link verifyResourceInstance}
 * records one verification under `resource/verified` (an instance may be
 * re-verified — each verification is its own row). {@link
 * readProjectResources} lists the project's requirements newest-first with
 * their instances and verifications nested. Every write runs in one `BEGIN
 * IMMEDIATE` transaction; requirement ids derive from identity
 * (`rr:<projectId>:<requirementKey>`), instance and verification ids from
 * their events' timeline sequences.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/resources
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import {
  RESOURCE_VERIFICATION_RESULTS,
  RESOURCE_VERIFIER_KINDS,
  type ResourceVerificationResult,
  type ResourceVerifierKind,
} from './project-events.js'
import type { PlanVersionId, ProjectId } from './plan-compile.js'
import { requireJsonObject } from './json-text.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one resource requirement row (`resource_requirements.id`). */
export type ResourceRequirementId = Branded<'ResourceRequirementId'>

/** Identity of one resource instance row (`resource_instances.id`). */
export type ResourceInstanceId = Branded<'ResourceInstanceId'>

/** Identity of one resource verification row (`resource_verifications.id`). */
export type ResourceVerificationId = Branded<'ResourceVerificationId'>

/** Actor recorded on resource events when the caller does not name one. */
export const DEFAULT_RESOURCE_ACTOR_REF = 'dsh-experimental-project-ledger/resources'

/** The controlled status of one resource requirement row; only `OPEN` has a writer. */
export type ResourceRequirementStatus = 'OPEN' | 'FULFILLED' | 'CANCELLED'

/** The controlled status of one resource instance row; only `AVAILABLE` has a writer. */
export type ResourceInstanceStatus = 'AVAILABLE' | 'RETIRED'

/** Closed set of resource-domain rejection reasons. */
export type ResourceErrorCode =
  | 'invalid-argument'
  | 'duplicate-requirement-key'
  | 'unknown-plan-version'
  | 'unknown-resource-requirement'
  | 'unknown-resource-instance'

/**
 * Thrown when a resource-domain write is rejected on ledger state or input.
 * The failing transaction has already rolled back, so the rejection itself
 * never writes.
 */
export class ResourceError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: ResourceErrorCode

  /** @param code - why the write was rejected. @param message - the concrete reason. */
  constructor(code: ResourceErrorCode, message: string) {
    super(message)
    this.name = 'ResourceError'
    this.code = code
  }
}

/** The requirement {@link openResourceRequirement} records. */
export interface OpenResourceRequirementInput {
  readonly requirementKey: string
  readonly requirementKind: string
  readonly name: string
  /** JSON text of the requirement's constraints; must parse as a JSON object. */
  readonly constraintsJson: string
  /** The actor the requirement asks a resource from, when one is named. */
  readonly requestedFrom?: string | undefined
  /** The plan version the requirement serves, when it names one; must belong to the same project. */
  readonly planVersionId?: PlanVersionId | undefined
}

/** The instance {@link provideResourceInstance} records. */
export interface ProvideResourceInstanceInput {
  readonly requirementId: ResourceRequirementId
  readonly label: string
  readonly provider?: string | undefined
  /** JSON text of instance metadata; must parse as a JSON object when present. */
  readonly metadataJson?: string | undefined
}

/** The verification {@link verifyResourceInstance} records. */
export interface VerifyResourceInstanceInput {
  readonly verifierKind: ResourceVerifierKind
  /** The verifier actor, when one is named. */
  readonly verifier?: string | undefined
  /** The stored spec the verdict answers; stored data, never executed. */
  readonly verificationSpec: string
  /** JSON text of the observed facts; must parse as a JSON object when present. */
  readonly observedJson?: string | undefined
  readonly result: ResourceVerificationResult
}

/** Options every resource write shares. */
export interface ResourceWriteOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_RESOURCE_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One verification recorded against a resource instance. */
export interface ResourceVerification {
  readonly verificationId: ResourceVerificationId
  readonly instanceId: ResourceInstanceId
  readonly verifierKind: ResourceVerifierKind
  readonly verifier: string | undefined
  readonly verificationSpec: string
  readonly observedJson: string | undefined
  readonly result: ResourceVerificationResult
  readonly verifiedAtMs: number
}

/** One instance provided against a requirement, with its verifications. */
export interface ResourceInstance {
  readonly instanceId: ResourceInstanceId
  readonly requirementId: ResourceRequirementId
  readonly label: string
  readonly provider: string | undefined
  readonly metadataJson: string | undefined
  readonly status: ResourceInstanceStatus
  readonly providedAtMs: number
  readonly verifications: readonly ResourceVerification[]
}

/** One requirement as {@link readProjectResources} lists it. */
export interface ResourceRequirement {
  readonly requirementId: ResourceRequirementId
  readonly projectId: ProjectId
  readonly planVersionId: PlanVersionId | undefined
  readonly requirementKey: string
  readonly requirementKind: string
  readonly name: string
  readonly constraintsJson: string
  readonly status: ResourceRequirementStatus
  readonly requestedFrom: string | undefined
  readonly createdAtMs: number
  readonly instances: readonly ResourceInstance[]
}

/** Reject an input string that must carry content. */
function requireNonEmpty(field: string, value: string): void {
  if (value.length === 0) {
    throw new ResourceError('invalid-argument', `${field} must not be empty`)
  }
}

/**
 * Open one resource requirement: validate the inputs, then record the
 * requirement and one `resource/required` event in a single `BEGIN
 * IMMEDIATE` transaction.
 * @param db - open ledger database.
 * @param projectId - project the requirement belongs to.
 * @param input - the requirement's identity, kind, name, and constraints.
 * @param options - actor and clock overrides.
 * @returns the recorded requirement; no instance serves it yet.
 * @throws {ResourceError} on `invalid-argument`, `duplicate-requirement-key`,
 * and `unknown-plan-version`.
 */
export function openResourceRequirement(
  db: DatabaseSync,
  projectId: ProjectId,
  input: OpenResourceRequirementInput,
  options: ResourceWriteOptions = {},
): ResourceRequirement {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_RESOURCE_ACTOR_REF
  requireNonEmpty('requirementKey', input.requirementKey)
  requireNonEmpty('requirementKind', input.requirementKind)
  requireNonEmpty('name', input.name)
  requireNonEmpty('constraintsJson', input.constraintsJson)
  requireJsonObject('constraintsJson', input.constraintsJson, message => new ResourceError('invalid-argument', message))
  const requirementId = brandString<ResourceRequirementId>(`rr:${projectId}:${input.requirementKey}`)
  db.exec('BEGIN IMMEDIATE')
  try {
    const duplicate = db.prepare(
      'SELECT id FROM resource_requirements WHERE project_id = ? AND requirement_key = ?',
    ).get(projectId, input.requirementKey) as { id: string } | undefined
    if (duplicate !== undefined) {
      throw new ResourceError(
        'duplicate-requirement-key',
        `requirement key "${input.requirementKey}" is already recorded in project "${projectId}" (${duplicate.id})`,
      )
    }
    if (input.planVersionId !== undefined) {
      const versionProject = db.prepare(
        'SELECT p.project_id AS project_id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = ?',
      ).get(input.planVersionId) as { project_id: string } | undefined
      if (versionProject === undefined || versionProject.project_id !== projectId) {
        throw new ResourceError(
          'unknown-plan-version',
          `plan version "${input.planVersionId}" is not recorded for project "${projectId}"`,
        )
      }
    }
    appendProjectEvent(
      db,
      projectId,
      'resource/required',
      {
        requirementId,
        requirementKey: input.requirementKey,
        requirementKind: input.requirementKind,
        name: input.name,
        constraintsJson: input.constraintsJson,
        ...(input.requestedFrom === undefined ? {} : { requestedFrom: input.requestedFrom }),
        ...(input.planVersionId === undefined ? {} : { planVersionId: input.planVersionId }),
      },
      { entityType: 'resource_requirement', entityId: requirementId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO resource_requirements '
      + '(id, project_id, plan_version_id, requirement_key, requirement_kind, name, constraints_json, status, '
      + 'requested_from, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      requirementId,
      projectId,
      input.planVersionId ?? null,
      input.requirementKey,
      input.requirementKind,
      input.name,
      input.constraintsJson,
      'OPEN',
      input.requestedFrom ?? null,
      nowMs,
    )
    db.exec('COMMIT')
    return {
      requirementId,
      projectId,
      planVersionId: input.planVersionId,
      requirementKey: input.requirementKey,
      requirementKind: input.requirementKind,
      name: input.name,
      constraintsJson: input.constraintsJson,
      status: 'OPEN',
      requestedFrom: input.requestedFrom,
      createdAtMs: nowMs,
      instances: [],
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Provide one resource instance against an OPEN requirement: validate the
 * inputs, then record the instance and one `resource/provided` event in a
 * single `BEGIN IMMEDIATE` transaction.
 * @param db - open ledger database.
 * @param input - the serving requirement and the instance's facts.
 * @param options - actor and clock overrides.
 * @returns the recorded instance; nothing verifies it yet.
 * @throws {ResourceError} on `invalid-argument`, `unknown-resource-requirement`.
 */
export function provideResourceInstance(
  db: DatabaseSync,
  input: ProvideResourceInstanceInput,
  options: ResourceWriteOptions = {},
): ResourceInstance {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_RESOURCE_ACTOR_REF
  requireNonEmpty('label', input.label)
  requireJsonObject('metadataJson', input.metadataJson, message => new ResourceError('invalid-argument', message))
  db.exec('BEGIN IMMEDIATE')
  try {
    const requirement = db.prepare(
      'SELECT id, project_id, status FROM resource_requirements WHERE id = ?',
    ).get(input.requirementId) as {
      id: string
      project_id: string
      status: ResourceRequirementStatus
    } | undefined
    if (requirement === undefined) {
      throw new ResourceError(
        'unknown-resource-requirement',
        `resource requirement "${input.requirementId}" is not recorded in this ledger`,
      )
    }
    if (requirement.status !== 'OPEN') {
      throw new ResourceError(
        'unknown-resource-requirement',
        `resource requirement "${input.requirementId}" is ${requirement.status}; instances serve OPEN requirements`,
      )
    }
    const projectId = brandString<ProjectId>(requirement.project_id)
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the instance id is its event's.
    const instanceId = brandString<ResourceInstanceId>(`ri:${projectId}:${nextProjectEventSequence(db, projectId)}`)
    appendProjectEvent(
      db,
      projectId,
      'resource/provided',
      {
        instanceId,
        requirementId: input.requirementId,
        label: input.label,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.metadataJson === undefined ? {} : { metadataJson: input.metadataJson }),
      },
      { entityType: 'resource_instance', entityId: instanceId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO resource_instances '
      + '(id, requirement_id, provider, label, metadata_json, status, provided_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      instanceId,
      input.requirementId,
      input.provider ?? null,
      input.label,
      input.metadataJson ?? null,
      'AVAILABLE',
      nowMs,
    )
    db.exec('COMMIT')
    return {
      instanceId,
      requirementId: input.requirementId,
      label: input.label,
      provider: input.provider,
      metadataJson: input.metadataJson,
      status: 'AVAILABLE',
      providedAtMs: nowMs,
      verifications: [],
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Verify one resource instance: validate the inputs, then record the
 * verification and one `resource/verified` event in a single `BEGIN
 * IMMEDIATE` transaction. The stored spec is data, never executed; an
 * instance may be re-verified, each attempt its own row.
 * @param db - open ledger database.
 * @param instanceId - the instance being verified.
 * @param input - the verdict, its kind, spec, and optional observed facts.
 * @param options - actor and clock overrides.
 * @returns the recorded verification.
 * @throws {ResourceError} on `invalid-argument` and `unknown-resource-instance`.
 */
export function verifyResourceInstance(
  db: DatabaseSync,
  instanceId: ResourceInstanceId,
  input: VerifyResourceInstanceInput,
  options: ResourceWriteOptions = {},
): ResourceVerification {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_RESOURCE_ACTOR_REF
  requireNonEmpty('verificationSpec', input.verificationSpec)
  requireJsonObject('observedJson', input.observedJson, message => new ResourceError('invalid-argument', message))
  if (!RESOURCE_VERIFIER_KINDS.includes(input.verifierKind)) {
    throw new ResourceError(
      'invalid-argument',
      `verifierKind must be one of ${RESOURCE_VERIFIER_KINDS.join(', ')}, `
        + `got ${JSON.stringify(input.verifierKind)}`,
    )
  }
  if (!RESOURCE_VERIFICATION_RESULTS.includes(input.result)) {
    throw new ResourceError(
      'invalid-argument',
      `result must be one of ${RESOURCE_VERIFICATION_RESULTS.join(', ')}, got ${JSON.stringify(input.result)}`,
    )
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const instance = db.prepare(
      'SELECT i.id, r.project_id FROM resource_instances i '
      + 'JOIN resource_requirements r ON r.id = i.requirement_id WHERE i.id = ?',
    ).get(instanceId) as { id: string; project_id: string } | undefined
    if (instance === undefined) {
      throw new ResourceError('unknown-resource-instance', `resource instance "${instanceId}" is not recorded in this ledger`)
    }
    const projectId = brandString<ProjectId>(instance.project_id)
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the verification id is its event's.
    const verificationId = brandString<ResourceVerificationId>(`rv:${instanceId}:${nextProjectEventSequence(db, projectId)}`)
    appendProjectEvent(
      db,
      projectId,
      'resource/verified',
      {
        verificationId,
        instanceId,
        verifierKind: input.verifierKind,
        ...(input.verifier === undefined ? {} : { verifier: input.verifier }),
        verificationSpec: input.verificationSpec,
        ...(input.observedJson === undefined ? {} : { observedJson: input.observedJson }),
        result: input.result,
        verifiedAtMs: nowMs,
      },
      { entityType: 'resource_verification', entityId: verificationId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO resource_verifications '
      + '(id, resource_instance_id, verifier, verifier_kind, verification_spec, observed_json, result, verified_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      verificationId,
      instanceId,
      input.verifier ?? null,
      input.verifierKind,
      input.verificationSpec,
      input.observedJson ?? null,
      input.result,
      nowMs,
    )
    db.exec('COMMIT')
    return {
      verificationId,
      instanceId,
      verifierKind: input.verifierKind,
      verifier: input.verifier,
      verificationSpec: input.verificationSpec,
      observedJson: input.observedJson,
      result: input.result,
      verifiedAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One flat read row joining a requirement with its instance, in select order. */
interface RequirementJoinRow {
  readonly id: string
  readonly plan_version_id: string | null
  readonly requirement_key: string
  readonly requirement_kind: string
  readonly name: string
  readonly constraints_json: string
  readonly status: ResourceRequirementStatus
  readonly requested_from: string | null
  readonly created_at_ms: number
}

/** One `resource_instances` row the read joins, in select order. */
interface InstanceRow {
  readonly id: string
  readonly requirement_id: string
  readonly provider: string | null
  readonly label: string
  readonly metadata_json: string | null
  readonly status: ResourceInstanceStatus
  readonly provided_at_ms: number
}

/** One `resource_verifications` row the read joins, in select order. */
interface VerificationRow {
  readonly id: string
  readonly resource_instance_id: string
  readonly verifier: string | null
  readonly verifier_kind: ResourceVerifierKind
  readonly verification_spec: string
  readonly observed_json: string | null
  readonly result: ResourceVerificationResult
  readonly verified_at_ms: number
}

/**
 * List one project's resource requirements newest-first, each with its
 * instances (provided order) and every instance's verifications
 * (verified order).
 * @param db - open ledger database.
 * @param projectId - project whose requirements are listed.
 * @returns the requirements in `created_at_ms` descending order; a project
 * the ledger records no requirement for reads as empty.
 */
export function readProjectResources(db: DatabaseSync, projectId: ProjectId): readonly ResourceRequirement[] {
  const requirementRows = db.prepare(
    'SELECT id, plan_version_id, requirement_key, requirement_kind, name, constraints_json, status, '
    + 'requested_from, created_at_ms FROM resource_requirements WHERE project_id = ? '
    + 'ORDER BY created_at_ms DESC, id',
  ).all(projectId) as unknown as RequirementJoinRow[]
  const instanceRows = db.prepare(
    'SELECT i.id, i.requirement_id, i.provider, i.label, i.metadata_json, i.status, i.provided_at_ms '
    + 'FROM resource_instances i JOIN resource_requirements r ON r.id = i.requirement_id '
    + 'WHERE r.project_id = ? ORDER BY i.provided_at_ms, i.id',
  ).all(projectId) as unknown as InstanceRow[]
  const verificationRows = db.prepare(
    'SELECT v.id, v.resource_instance_id, v.verifier, v.verifier_kind, v.verification_spec, v.observed_json, '
    + 'v.result, v.verified_at_ms FROM resource_verifications v '
    + 'JOIN resource_instances i ON i.id = v.resource_instance_id '
    + 'JOIN resource_requirements r ON r.id = i.requirement_id '
    + 'WHERE r.project_id = ? ORDER BY v.verified_at_ms, v.id',
  ).all(projectId) as unknown as VerificationRow[]

  const verificationsByInstance = new Map<string, ResourceVerification[]>()
  for (const row of verificationRows) {
    const verifications = verificationsByInstance.get(row.resource_instance_id) ?? []
    verifications.push({
      verificationId: brandString<ResourceVerificationId>(row.id),
      instanceId: brandString<ResourceInstanceId>(row.resource_instance_id),
      verifierKind: row.verifier_kind,
      verifier: row.verifier ?? undefined,
      verificationSpec: row.verification_spec,
      observedJson: row.observed_json ?? undefined,
      result: row.result,
      verifiedAtMs: row.verified_at_ms,
    })
    verificationsByInstance.set(row.resource_instance_id, verifications)
  }
  const instancesByRequirement = new Map<string, ResourceInstance[]>()
  for (const row of instanceRows) {
    const instances = instancesByRequirement.get(row.requirement_id) ?? []
    instances.push({
      instanceId: brandString<ResourceInstanceId>(row.id),
      requirementId: brandString<ResourceRequirementId>(row.requirement_id),
      label: row.label,
      provider: row.provider ?? undefined,
      metadataJson: row.metadata_json ?? undefined,
      status: row.status,
      providedAtMs: row.provided_at_ms,
      verifications: verificationsByInstance.get(row.id) ?? [],
    })
    instancesByRequirement.set(row.requirement_id, instances)
  }
  return requirementRows.map(row => ({
    requirementId: brandString<ResourceRequirementId>(row.id),
    projectId,
    planVersionId: row.plan_version_id === null ? undefined : brandString<PlanVersionId>(row.plan_version_id),
    requirementKey: row.requirement_key,
    requirementKind: row.requirement_kind,
    name: row.name,
    constraintsJson: row.constraints_json,
    status: row.status,
    requestedFrom: row.requested_from ?? undefined,
    createdAtMs: row.created_at_ms,
    instances: instancesByRequirement.get(row.id) ?? [],
  }))
}
