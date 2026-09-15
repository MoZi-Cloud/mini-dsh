import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readHeadCommit } from '../src/git.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-analysis-git-'))
  roots.push(root)
  return root
}

const SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

describe('readHeadCommit', () => {
  it('returns undefined facts outside a git worktree', () => {
    expect(readHeadCommit(tmpRepo())).toEqual({ commitSha: undefined, refName: undefined })
  })

  it('resolves a branch HEAD through the loose ref', () => {
    const root = tmpRepo()
    mkdirSync(join(root, '.git/refs/heads'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/master\n')
    writeFileSync(join(root, '.git/refs/heads/master'), `${SHA}\n`)
    expect(readHeadCommit(root)).toEqual({ commitSha: SHA, refName: 'refs/heads/master' })
  })

  it('resolves a branch HEAD through packed-refs when the loose ref is absent', () => {
    const root = tmpRepo()
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, '.git/packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${OTHER_SHA} refs/heads/main\n${SHA} refs/heads/other\n`)
    expect(readHeadCommit(root)).toEqual({ commitSha: OTHER_SHA, refName: 'refs/heads/main' })
  })

  it('reports an unresolved branch when the ref points nowhere', () => {
    const root = tmpRepo()
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/unborn\n')
    expect(readHeadCommit(root)).toEqual({ commitSha: undefined, refName: 'refs/heads/unborn' })
  })

  it('resolves a detached HEAD written as a raw sha', () => {
    const root = tmpRepo()
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), `${SHA}\n`)
    expect(readHeadCommit(root)).toEqual({ commitSha: SHA, refName: undefined })
  })

  it('resolves through a linked worktree gitdir pointer', () => {
    const mainRepo = tmpRepo()
    const gitDir = join(mainRepo, '.git/worktrees/feature')
    mkdirSync(join(gitDir, 'refs/heads'), { recursive: true })
    writeFileSync(join(gitDir, 'refs/heads/feature'), `${OTHER_SHA}\n`)
    const worktree = tmpRepo()
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n')
    expect(readHeadCommit(worktree)).toEqual({ commitSha: OTHER_SHA, refName: 'refs/heads/feature' })
  })

  it('resolves packed refs through a declared commondir', () => {
    const mainRepo = tmpRepo()
    mkdirSync(join(mainRepo, '.git'), { recursive: true })
    writeFileSync(join(mainRepo, '.git/packed-refs'), `${SHA} refs/heads/shared\n`)
    const worktreeGit = join(mainRepo, '.git/worktrees/feature')
    mkdirSync(worktreeGit, { recursive: true })
    writeFileSync(join(worktreeGit, 'HEAD'), 'ref: refs/heads/shared\n')
    writeFileSync(join(worktreeGit, 'commondir'), '../..\n')
    const worktree = tmpRepo()
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGit}\n`)
    expect(readHeadCommit(worktree)).toEqual({ commitSha: SHA, refName: 'refs/heads/shared' })
  })

  it('ignores a non-gitdir .git file', () => {
    const root = tmpRepo()
    writeFileSync(join(root, '.git'), 'not a pointer\n')
    expect(readHeadCommit(root)).toEqual({ commitSha: undefined, refName: undefined })
  })

  it('ignores a short or malformed sha in a detached HEAD', () => {
    const root = tmpRepo()
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), 'abc123\n')
    expect(readHeadCommit(root)).toEqual({ commitSha: undefined, refName: undefined })
  })
})
