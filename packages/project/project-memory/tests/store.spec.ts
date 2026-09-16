import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProjectMemory,
  ProjectMemoryError,
  contentId,
  type MemoryId,
  type ProjectMemoryErrorCode,
  type SnapshotId,
} from '../src/index.ts'
import { PROJECT_MEMORY_SCHEMA_VERSION } from '../src/schema.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-memory-'))
  roots.push(root)
  return join(root, name)
}

function captureCode(fn: () => unknown): ProjectMemoryErrorCode {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectMemoryError)
    return (error as ProjectMemoryError).code
  }
  throw new Error('expected the call to throw')
}

describe('open and close', () => {
  it('creates a fresh on-disk database stamped with the current schema version', async () => {
    const path = tmpFile('memory.sqlite')
    const memory = await ProjectMemory.open(path)
    memory.close()
    const raw = new DatabaseSync(path)
    const { user_version: version } = raw.prepare('PRAGMA user_version').get() as { user_version: number }
    raw.close()
    expect(version).toBe(PROJECT_MEMORY_SCHEMA_VERSION)
  })

  it('rejects a database stamped with an incompatible schema version', async () => {
    const path = tmpFile('memory.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 999')
    raw.close()
    await expect(ProjectMemory.open(path)).rejects.toThrow(ProjectMemoryError)
    await expect(ProjectMemory.open(path)).rejects.toHaveProperty('code', 'version-mismatch')
  })

  it('rejects every write after close with code closed', async () => {
    const memory = await ProjectMemory.open(':memory:')
    memory.close()
    expect(captureCode(() => memory.putContent('x'))).toBe('closed')
    expect(captureCode(() => memory.transaction(() => 1))).toBe('closed')
  })
})

describe('content store', () => {
  it('stores text once per distinct content and reports byte length', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const id = memory.putContent('export const x = 1\n')
    expect(id).toBe(contentId('export const x = 1\n'))
    expect(memory.getContent(id)).toMatchObject({ kind: 'text', byteLength: 19, text: 'export const x = 1\n' })
    expect(memory.putContent('export const x = 1\n')).toBe(id)
    expect(memory.getContent(contentId('other'))).toBeUndefined()
    memory.close()
  })

  it('stores json content under the json kind', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const id = memory.putContent('{"a":1}', 'json')
    expect(memory.getContent(id)).toMatchObject({ kind: 'json', text: '{"a":1}' })
    memory.close()
  })
})

describe('repositories and snapshots', () => {
  it('upserts by slug, keeping the id while refreshing location fields', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const first = memory.upsertRepository({ slug: 'mini-dsh', url: 'https://example.invalid/mini-dsh.git' })
    const second = memory.upsertRepository({ slug: 'mini-dsh', localPath: '/tmp/mini-dsh', defaultBranch: 'master' })
    expect(second.id).toBe(first.id)
    expect(second.url).toBeUndefined()
    expect(second.localPath).toBe('/tmp/mini-dsh')
    expect(second.defaultBranch).toBe('master')
    expect(memory.getRepositoryBySlug('mini-dsh')?.id).toBe(first.id)
    expect(memory.getRepositoryBySlug('missing')).toBeUndefined()
    expect(memory.getRepository(first.id)?.slug).toBe('mini-dsh')
    memory.close()
  })

  it('records snapshots with commit, dirtiness, and capture time', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const repository = memory.upsertRepository({ slug: 'mini-dsh' })
    const snapshot = memory.insertSnapshot({
      repositoryId: repository.id,
      snapshotKind: 'pinned',
      commitSha: 'fixture-commit-sha',
    })
    expect(snapshot).toMatchObject({
      repositoryId: repository.id,
      snapshotKind: 'pinned',
      commitSha: 'fixture-commit-sha',
      dirty: false,
    })
    expect(snapshot.capturedAtMs).toBeGreaterThan(0)
    expect(memory.getSnapshot(snapshot.id)).toMatchObject({ commitSha: 'fixture-commit-sha' })
    expect(memory.getRepository(repository.id)).toBeDefined()
    memory.close()
  })
})

describe('symbols, files, and the call graph', () => {
  interface SeededGraph {
    readonly memory: ProjectMemory
    readonly snapshotId: SnapshotId
  }

  async function seededGraph(): Promise<SeededGraph> {
    const memory = await ProjectMemory.open(':memory:')
    const repository = memory.upsertRepository({ slug: 'mini-dsh' })
    const snapshot = memory.insertSnapshot({ repositoryId: repository.id, snapshotKind: 'head', commitSha: 'abc' })
    const file = memory.insertFile({
      snapshotId: snapshot.id,
      path: 'src/agent.ts',
      language: 'typescript',
      byteLength: 42,
      contentId: memory.putContent('export function agent() {}\n'),
    })
    const calleeSymbol = memory.upsertSymbol(repository.id, 'symbol:src/agent.ts:agent')
    const callee = memory.insertSymbolVersion({
      symbolId: calleeSymbol.id,
      snapshotId: snapshot.id,
      fileId: file.id,
      name: 'agent',
      qualifiedName: 'agent',
      symbolKind: 'function',
      startLine: 1,
      endLine: 1,
      signatureText: 'agent(): void',
      isExported: true,
      isAsync: false,
      isStatic: false,
      extractionLevel: 'syntactic',
    })
    const callerSymbol = memory.upsertSymbol(repository.id, 'symbol:src/loop.ts:runLoop')
    const caller = memory.insertSymbolVersion({
      symbolId: callerSymbol.id,
      snapshotId: snapshot.id,
      fileId: file.id,
      name: 'runLoop',
      qualifiedName: 'runLoop',
      symbolKind: 'function',
      startLine: 3,
      endLine: 5,
      signatureText: 'runLoop(): Promise<void>',
      isExported: true,
      isAsync: true,
      isStatic: false,
      extractionLevel: 'typechecker',
    })
    memory.insertImport({ fileId: file.id, moduleSpecifier: 'node:path', isTypeOnly: false, line: 1 })
    memory.insertCallSite({
      snapshotId: snapshot.id,
      fileId: file.id,
      line: 4,
      column: 3,
      callerSymbolVersionId: caller.id,
      calleeName: 'agent',
      calleeSymbolVersionId: callee.id,
      resolution: 'resolved',
      extractionLevel: 'typechecker',
    })
    memory.insertCallSite({
      snapshotId: snapshot.id,
      fileId: file.id,
      line: 5,
      column: 3,
      callerSymbolVersionId: caller.id,
      calleeName: 'console.log',
      resolution: 'external',
      extractionLevel: 'typechecker',
    })
    memory.insertSymbolReference({
      snapshotId: snapshot.id,
      fileId: file.id,
      line: 2,
      referencingSymbolVersionId: caller.id,
      referencedSymbolVersionId: callee.id,
      referenceKind: 'type',
    })
    memory.insertProjectObject({
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      objectKind: 'file',
      stableKey: 'file:src/agent.ts',
      name: 'agent.ts',
    })
    return { memory, snapshotId: snapshot.id }
  }

  it('round-trips symbol identities and per-snapshot facts', async () => {
    const { memory, snapshotId } = await seededGraph()
    const repository = memory.getRepositoryBySlug('mini-dsh')!
    const identity = memory.upsertSymbol(repository.id, 'symbol:src/agent.ts:agent')
    expect(identity.stableKey).toBe('symbol:src/agent.ts:agent')
    const found = memory.findSymbolVersionsByName(snapshotId, 'agent')
    expect(found.map(version => version.qualifiedName)).toEqual(['agent'])
    expect(memory.getSymbolVersion(found[0]!.id)).toMatchObject({ isAsync: false })
    expect(memory.findSymbolVersionsByFile(found[0]!.fileId)).toHaveLength(2)
    memory.close()
  })

  it('answers caller and callee queries over stored edges', async () => {
    const { memory, snapshotId } = await seededGraph()
    const callee = memory.findSymbolVersionsByName(snapshotId, 'agent')[0]!
    const caller = memory.findSymbolVersionsByName(snapshotId, 'runLoop')[0]!
    const callers = memory.callersOf(callee.snapshotId, callee.id)
    expect(callers).toHaveLength(1)
    expect(callers[0]).toMatchObject({ calleeName: 'agent', resolution: 'resolved', line: 4 })
    const callees = memory.calleesOf(caller.snapshotId, caller.id)
    expect(callees.map(site => site.calleeName)).toEqual(['agent', 'console.log'])
    const references = memory.referencesTo(callee.snapshotId, callee.id)
    expect(references).toMatchObject([{ referenceKind: 'type', line: 2 }])
    const all = memory.callSitesInSnapshot(callee.snapshotId)
    expect(all).toHaveLength(2)
    memory.close()
  })

  it('aggregates snapshot stats by resolution', async () => {
    const { memory, snapshotId } = await seededGraph()
    expect(memory.snapshotStats(snapshotId)).toMatchObject({
      files: 1,
      symbols: 2,
      callSites: 2,
      resolvedCalls: 1,
      externalCalls: 1,
      unresolvedCalls: 0,
      dynamicCalls: 0,
      projectObjects: 1,
    })
    memory.close()
  })

  it('rolls back the whole transaction when a write fails', async () => {
    const { memory, snapshotId } = await seededGraph()
    const repository = memory.getRepositoryBySlug('mini-dsh')!
    expect(() => {
      memory.transaction(() => {
        memory.insertProjectObject({
          repositoryId: repository.id,
          snapshotId,
          objectKind: 'file',
          stableKey: 'file:kept',
          name: 'kept.ts',
        })
        // Duplicate stable key inside the same transaction fails loudly.
        memory.insertProjectObject({
          repositoryId: repository.id,
          snapshotId,
          objectKind: 'file',
          stableKey: 'file:kept',
          name: 'kept.ts',
        })
      })
    }).toThrow()
    expect(memory.findProjectObjectByStableKey(snapshotId, 'file:kept')).toBeUndefined()
    memory.close()
  })

  it('turns nested transactions into savepoints that roll back scoped', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const repository = memory.upsertRepository({ slug: 'mini-dsh' })
    let innerId: MemoryId | undefined
    let goneId: MemoryId | undefined
    const outer = memory.transaction(() => {
      memory.transaction(() => {
        innerId = memory.insertMemory({ repositoryId: repository.id, scope: 'inner', content: 'inner write' }).id
      })
      try {
        memory.transaction(() => {
          goneId = memory.insertMemory({ repositoryId: repository.id, scope: 'rolled-back', content: 'gone' }).id
          throw new Error('scoped failure')
        })
      } catch (error) {
        expect((error as Error).message).toBe('scoped failure')
      }
      memory.insertMemory({ repositoryId: repository.id, scope: 'outer', content: 'outer write' })
      return 'outer-ok'
    })
    expect(outer).toBe('outer-ok')
    expect(memory.getMemory(innerId!)).toMatchObject({ scope: 'inner' })
    expect(memory.getMemory(goneId!)).toBeUndefined()
    memory.close()
  })
})

describe('memories, evidence, analysis units, and run events', () => {
  it('stores memory text as content and lists attached evidence', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const repository = memory.upsertRepository({ slug: 'mini-dsh' })
    const stored = memory.insertMemory({
      repositoryId: repository.id,
      scope: 'architecture',
      content: 'The loop owns the inbox.',
    })
    expect(memory.getMemory(stored.id)).toMatchObject({ scope: 'architecture', status: 'active' })
    expect(memory.getContent(stored.contentId)?.text).toBe('The loop owns the inbox.')
    memory.attachMemoryEvidence({ memoryId: stored.id, lineStart: 10, lineEnd: 12, quote: 'inbox.claim(target)' })
    const evidence = memory.listMemoryEvidence(stored.id)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ lineStart: 10, lineEnd: 12 })
    expect(memory.getContent(evidence[0]!.quoteContentId!)?.text).toBe('inbox.claim(target)')
    memory.close()
  })

  it('records analysis units with question content and append-only history', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const repository = memory.upsertRepository({ slug: 'mini-dsh' })
    const unit = memory.insertAnalysisUnit({
      repositoryId: repository.id,
      unitKind: 'question',
      title: 'Who calls preStep?',
      question: 'List every caller of ReactLoopAgent.preStep.',
    })
    expect(memory.getAnalysisUnit(unit.id)).toMatchObject({ status: 'open', unitKind: 'question' })
    expect(memory.getContent(unit.questionContentId!)?.text).toContain('preStep')
    memory.appendAnalysisHistory(unit.id, 'answered', 'three callers')
    memory.appendAnalysisHistory(unit.id, 'recorded')
    const history = memory.listAnalysisHistory(unit.id)
    expect(history.map(row => row.event)).toEqual(['answered', 'recorded'])
    expect(memory.getContent(history[0]!.detailContentId!)?.text).toBe('three callers')
    memory.close()
  })

  it('records run events with JSON payloads', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const repository = memory.upsertRepository({ slug: 'mini-dsh' })
    memory.recordRunEvent(repository.id, 'index-completed', { files: 3 })
    memory.recordRunEvent(repository.id, 'index-started')
    const events = memory.listRunEvents(repository.id)
    expect(events.map(row => row.eventKind)).toEqual(['index-completed', 'index-started'])
    expect(JSON.parse(memory.getContent(events[0]!.payloadContentId!)?.text ?? 'null')).toEqual({ files: 3 })
    expect(events[1]!.payloadContentId).toBeUndefined()
    memory.close()
  })
})
