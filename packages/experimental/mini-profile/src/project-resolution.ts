/**
 * Single-project resolution shared by the mini profile's surfaces (v1.6a
 * §5.4): the `/project` command and the project-work tools both address one
 * project at a time, and the ledger's plan directory is the only resolution
 * input. The error text is caller-displayable, so every consuming surface can
 * surface it verbatim.
 *
 * @module @deepseek-ai/dsh-experimental-mini-profile/project-resolution
 */

import type { PlanDirectoryEntry, ProjectId } from '@deepseek-ai/dsh-experimental-project-ledger'

/** Internal control-flow signal carrying caller-facing error text out of the resolver. */
export class ProjectResolutionError extends Error {}

/**
 * Resolve which project a request addresses. Implicit resolution needs one
 * project, not one plan: several plans of the same project name the same
 * target.
 * @param plans - the ledger's plan directory.
 * @param explicit - the project id the caller named, if any.
 * @returns the project id to act on.
 * @throws {ProjectResolutionError} when the named project is absent, or the implicit single-project resolution is ambiguous or empty.
 */
export function resolveProjectId(plans: readonly PlanDirectoryEntry[], explicit: string | undefined): ProjectId {
  if (explicit !== undefined) {
    const named = plans.find(plan => plan.projectId === explicit)
    if (named === undefined) {
      throw new ProjectResolutionError(`No plan in this ledger records project "${explicit}".`)
    }
    return named.projectId
  }
  const projectIds = [...new Set(plans.map(plan => plan.projectId))]
  const [only, ...rest] = projectIds
  if (only === undefined) {
    throw new ProjectResolutionError('This ledger records no plan yet. Import a plan version first.')
  }
  if (rest.length > 0) {
    throw new ProjectResolutionError(
      'This ledger records more than one project. Name one: ' + projectIds.join(', ') + '.',
    )
  }
  return only
}
