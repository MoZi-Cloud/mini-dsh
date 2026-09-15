import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectMemory, ProjectMemoryError } from '@deepseek-ai/dsh-project-memory'
import { indexRepository } from '../src/index.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-analysis-index-'))
  roots.push(root)
  mkdirSync(join(root, 'packages/demo/util/src'), { recursive: true })
  writeFileSync(join(root, 'packages/demo/util/package.json'), '{"name":"@demo/util"}\n')
  writeFileSync(
    join(root, 'packages/demo/util/src/helper.ts'),
    [
      'export interface HelperOptions {',
      '  retries: number',
      '}',
      'export function helper(input: string): number {',
      '  return input.length',
      '}',
      'export function useHelper(options: HelperOptions): number {',
      '  return helper("fixed") + options.retries',
      '}',
    ].join('\n') + '\n',
  )
  writeFileSync(
    join(root, 'packages/demo/util/src/agent.ts'),
    [
      "import { helper } from './helper.ts'",
      'import type { HelperOptions } from "./helper.ts"',
      'export function preStep(target: string): Promise<string> {',
      '  return Promise.resolve(helper(target))',
      '}',
      'export function brokenCall(): void {',
      '  definitelyNotDefinedAnywhere()',
      '}',
    ].join('\n') + '\n',
  )
  return root
}

describe('indexRepository', () => {
  it('requires an explicit commit for pinned snapshots', async () => {
    const memory = await ProjectMemory.open(':memory:')
    expect(() => indexRepository(memory, { root: fixtureRepo(), snapshotKind: 'pinned' })).toThrow(ProjectMemoryError)
    memory.close()
  })

  it('requires a resolvable HEAD for head snapshots', async () => {
    const memory = await ProjectMemory.open(':memory:')
    expect(() => indexRepository(memory, { root: fixtureRepo(), snapshotKind: 'head' })).toThrow(/no resolvable HEAD/)
    memory.close()
  })

  it('captures a head snapshot from the fixture git metadata', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const root = fixtureRepo()
    mkdirSync(join(root, '.git/refs/heads'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, '.git/refs/heads/main'), '0123456789abcdef0123456789abcdef01234567\n')
    const report = indexRepository(memory, { root, snapshotKind: 'head', slug: 'fixture' })
    expect(report.commitSha).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(report.fileCount).toBe(2)
    expect(report.symbolCount).toBe(5)
    memory.close()
  })

  it('indexes a worktree without git metadata and resolves the call graph', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const root = fixtureRepo()
    const report = indexRepository(memory, { root, snapshotKind: 'worktree' })
    expect(report.dirty).toBe(true)
    expect(report.commitSha).toBeUndefined()
    // helper(target) inside preStep resolves to the helper symbol version.
    expect(report.resolvedCalls).toBeGreaterThanOrEqual(1)
    // Promise.resolve and console-style library callees are external.
    expect(report.externalCalls).toBeGreaterThanOrEqual(1)
    // definitelyNotDefinedAnywhere stays unresolved.
    expect(report.unresolvedCalls).toBeGreaterThanOrEqual(1)
    // The HelperOptions type reference from agent.ts is recorded.
    expect(report.typeReferenceCount).toBeGreaterThanOrEqual(1)
    expect(report.diagnosticCount).toBe(0)

    const helper = memory.findSymbolVersionsByName(report.snapshotId, 'helper')[0]!
    expect(helper.signatureText).toBe('helper(input: string): number')
    const callers = memory.callersOf(report.snapshotId, helper.id)
    expect(callers.map(site => site.calleeName).sort()).toEqual(['helper', 'helper'])
    const fileObject = memory.findProjectObjectByStableKey(report.snapshotId, 'file:packages/demo/util/src/helper.ts')
    expect(fileObject).toBeDefined()
    const symbolObject = memory.findProjectObjectByStableKey(report.snapshotId, 'symbol:packages/demo/util/src/helper.ts:helper')
    expect(symbolObject?.symbolVersionId).toBe(helper.id)
    const packageObject = memory.findProjectObjectByStableKey(report.snapshotId, 'package:packages/demo/util')
    expect(packageObject?.name).toBe('@demo/util')
    const events = memory.listRunEvents(report.repositoryId)
    expect(events.map(event => event.eventKind)).toEqual(['index-completed'])
    memory.close()
  })

  it('keeps every call unresolved at the syntactic level', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const report = indexRepository(memory, { root: fixtureRepo(), snapshotKind: 'worktree', level: 'syntactic' })
    expect(report.resolvedCalls).toBe(0)
    expect(report.externalCalls).toBe(0)
    expect(report.typeReferenceCount).toBe(0)
    expect(report.unresolvedCalls + report.dynamicCalls).toBe(report.callSiteCount)
    memory.close()
  })

  it('counts syntactic diagnostics for files that fail to parse', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const root = fixtureRepo()
    writeFileSync(join(root, 'packages/demo/util/src/broken.ts'), 'export function ( {{{\n')
    const report = indexRepository(memory, { root, snapshotKind: 'worktree' })
    expect(report.diagnosticCount).toBeGreaterThan(0)
    memory.close()
  })

  it('appends a second snapshot without touching the first', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const root = fixtureRepo()
    const first = indexRepository(memory, { root, snapshotKind: 'worktree' })
    writeFileSync(join(root, 'packages/demo/util/src/extra.ts'), 'export function extra(): void {}\n')
    const second = indexRepository(memory, { root, snapshotKind: 'worktree' })
    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect(second.fileCount).toBe(first.fileCount + 1)
    expect(memory.snapshotStats(first.snapshotId).files).toBe(first.fileCount)
    memory.close()
  })
})
