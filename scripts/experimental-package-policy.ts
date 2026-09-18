/**
 * Experimental packages excluded from public releases and npm baselines.
 * `mini-profile` is this repository's own per-profile ledger attach bundle
 * (dsh plugin add), not a publishable capability: it layers one insert over
 * the private dsh-base proof and has no consumer outside this tree.
 */
export const PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES: readonly string[] = [
  'packages/experimental/mini-profile',
]

/**
 * Whether an experimental package publishes under the default-public policy.
 * @param directory - repository-relative package directory.
 * @param privateDirectories - experimental directories excluded from publication.
 * @returns Whether the package publishes with the dsh family.
 */
export function isPublicExperimentalPackageDirectory(
  directory: string,
  privateDirectories: readonly string[] = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
): boolean {
  return /^packages\/experimental\/[^/]+$/.test(directory)
    && !privateDirectories.includes(directory)
}
