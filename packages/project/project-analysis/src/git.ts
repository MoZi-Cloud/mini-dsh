/**
 * Filesystem-only git HEAD resolution for snapshot pinning. Reads `.git`
 * directly (HEAD, loose refs, packed-refs, worktree `gitdir:` pointers, and
 * `commondir` links) so indexing never spawns a git subprocess.
 *
 * @module @deepseek-ai/dsh-project-analysis/git
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** The resolved state of a worktree's git metadata. */
export interface HeadInfo {
  /** Commit sha the HEAD points at, or `undefined` when it cannot be determined. */
  readonly commitSha: string | undefined
  /** Symbolic ref name (for example `refs/heads/master`), or `undefined` when detached. */
  readonly refName: string | undefined
}

/**
 * Read the commit a worktree's HEAD points at, without running git.
 *
 * Handles plain repositories (`.git` directory), linked worktrees (`.git`
 * file with a `gitdir:` pointer), detached HEADs (raw sha), loose refs, and
 * `packed-refs` (read from the common directory when one is declared). A
 * missing ref object yields `commitSha: undefined` rather than failing: the
 * caller decides whether a sha is required.
 * @param root - the worktree root to inspect.
 * @returns the HEAD resolution for that worktree.
 */
export function readHeadCommit(root: string): HeadInfo {
  const gitPath = resolve(root, '.git')
  if (!existsSync(gitPath)) return { commitSha: undefined, refName: undefined }
  let gitDir = gitPath
  if (!isDirectory(gitPath)) {
    const pointer = readFileSync(gitPath, 'utf8').trim()
    if (!pointer.startsWith('gitdir:')) return { commitSha: undefined, refName: undefined }
    const target = pointer.slice('gitdir:'.length).trim()
    gitDir = isAbsolute(target) ? target : resolve(root, target)
  }
  const commonDir = readCommonDir(gitDir)
  return resolveHead(gitDir, commonDir)
}

function resolveHead(gitDir: string, commonDir: string): HeadInfo {
  const headPath = `${gitDir}/HEAD`
  if (!existsSync(headPath)) return { commitSha: undefined, refName: undefined }
  const head = readFileSync(headPath, 'utf8').trim()
  if (!head.startsWith('ref:')) {
    return isCommitSha(head) ? { commitSha: head, refName: undefined } : { commitSha: undefined, refName: undefined }
  }
  const refName = head.slice('ref:'.length).trim()
  const loose = readLooseRef(gitDir, refName) ?? readLooseRef(commonDir, refName)
  if (loose !== undefined) return { commitSha: loose, refName }
  const packed = readPackedRef(commonDir, refName) ?? readPackedRef(gitDir, refName)
  if (packed !== undefined) return { commitSha: packed, refName }
  return { commitSha: undefined, refName }
}

function readCommonDir(gitDir: string): string {
  const commonPath = `${gitDir}/commondir`
  if (!existsSync(commonPath)) return gitDir
  const target = readFileSync(commonPath, 'utf8').trim()
  return isAbsolute(target) ? target : resolve(gitDir, target)
}

function readLooseRef(gitDir: string, refName: string): string | undefined {
  const refPath = `${gitDir}/${refName}`
  if (!existsSync(refPath)) return undefined
  const value = readFileSync(refPath, 'utf8').trim()
  return isCommitSha(value) ? value : undefined
}

function readPackedRef(gitDir: string, refName: string): string | undefined {
  const packedPath = `${gitDir}/packed-refs`
  if (!existsSync(packedPath)) return undefined
  for (const line of readFileSync(packedPath, 'utf8').split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue
    const [sha, name] = line.split(' ')
    if (name === refName && isCommitSha(sha)) return sha
  }
  return undefined
}

function isCommitSha(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40}$/.test(value)
}

function isDirectory(path: string): boolean {
  return statSync(path).isDirectory()
}
