import { describe, expect, it } from 'vitest'
import { ProjectMemory, buildContextPacket, estimateTokens, type SnapshotId } from '../src/index.ts'
import { CONTEXT_LANE_TOKEN_BUDGET } from '../src/context-packet.ts'

describe('estimateTokens', () => {
  it('returns zero for empty text and scales with UTF-8 bytes', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    // 汉字 encodes to three UTF-8 bytes per character.
    expect(estimateTokens('汉')).toBe(1)
    expect(estimateTokens('汉字汉字')).toBe(3)
  })
})

describe('buildContextPacket', () => {
  interface Seeded {
    readonly memory: ProjectMemory
    readonly snapshotId: SnapshotId
  }

  async function seeded(): Promise<Seeded> {
    const memory = await ProjectMemory.open(':memory:')
    const repository = memory.upsertRepository({ slug: 'mini-dsh' })
    const snapshot = memory.insertSnapshot({ repositoryId: repository.id, snapshotKind: 'head', commitSha: 'abc' })
    const file = memory.insertFile({
      snapshotId: snapshot.id,
      path: 'src/agent.ts',
      language: 'typescript',
      byteLength: 42,
    })
    const helperSymbol = memory.upsertSymbol(repository.id, 'symbol:src/util.ts:helper')
    const helper = memory.insertSymbolVersion({
      symbolId: helperSymbol.id,
      snapshotId: snapshot.id,
      fileId: file.id,
      name: 'helper',
      qualifiedName: 'helper',
      symbolKind: 'function',
      startLine: 1,
      endLine: 2,
      signatureText: 'helper(input: string): number',
      isExported: true,
      isAsync: false,
      isStatic: false,
      extractionLevel: 'typechecker',
    })
    const callerSymbol = memory.upsertSymbol(repository.id, 'symbol:src/agent.ts:runAgent')
    const caller = memory.insertSymbolVersion({
      symbolId: callerSymbol.id,
      snapshotId: snapshot.id,
      fileId: file.id,
      name: 'runAgent',
      qualifiedName: 'runAgent',
      symbolKind: 'function',
      startLine: 4,
      endLine: 9,
      signatureText: 'runAgent(task: string): Promise<void>',
      isExported: true,
      isAsync: true,
      isStatic: false,
      extractionLevel: 'typechecker',
    })
    memory.insertCallSite({
      snapshotId: snapshot.id,
      fileId: file.id,
      line: 6,
      column: 3,
      callerSymbolVersionId: caller.id,
      calleeName: 'helper',
      calleeSymbolVersionId: helper.id,
      resolution: 'resolved',
      extractionLevel: 'typechecker',
    })
    return { memory, snapshotId: snapshot.id }
  }

  it('assembles a symbol packet within the reviewed lane budget', async () => {
    const { memory, snapshotId } = await seeded()
    const packet = buildContextPacket(memory, { kind: 'symbol', snapshotId, name: 'helper' })
    expect(packet.overflow).toBe(false)
    expect(packet.tokenEstimate).toBeLessThanOrEqual(CONTEXT_LANE_TOKEN_BUDGET)
    expect(packet.includedSections).toEqual(['helper (function)'])
    expect(packet.elidedSections).toEqual([])
    expect(packet.text).toContain('signature: helper(input: string): number')
    expect(packet.text).toContain('file: src/agent.ts')
    memory.close()
  })

  it('assembles caller and callee packets for stored edges', async () => {
    const { memory, snapshotId } = await seeded()
    const helper = memory.findSymbolVersionsByName(snapshotId, 'helper')[0]!
    const callers = buildContextPacket(memory, { kind: 'callers', snapshotId, callee: helper.id })
    expect(callers.includedSections).toEqual(['call at src/agent.ts:6'])
    expect(callers.text).toContain('caller: runAgent')
    const caller = memory.findSymbolVersionsByName(snapshotId, 'runAgent')[0]!
    const callees = buildContextPacket(memory, { kind: 'callees', snapshotId, caller: caller.id })
    expect(callees.text).toContain('callee: helper')
    expect(callees.overflow).toBe(false)
    memory.close()
  })

  it('elides sections that do not fit instead of overflowing the budget', async () => {
    const { memory, snapshotId } = await seeded()
    // The header (~21 estimated tokens) fits; the one section does not.
    const packet = buildContextPacket(memory, { kind: 'symbol', snapshotId, name: 'helper' }, 40)
    expect(packet.overflow).toBe(false)
    expect(packet.includedSections).toEqual([])
    expect(packet.elidedSections).toEqual(['helper (function)'])
    memory.close()
  })

  it('marks overflow when even the header exceeds the budget', async () => {
    const { memory, snapshotId } = await seeded()
    const packet = buildContextPacket(memory, { kind: 'symbol', snapshotId, name: 'helper' }, 0)
    expect(packet.overflow).toBe(true)
    memory.close()
  })

  it('fails closed for a symbol name absent from the snapshot', async () => {
    const { memory, snapshotId } = await seeded()
    expect(() => buildContextPacket(memory, { kind: 'symbol', snapshotId, name: 'missing' })).toThrow(
      /no symbol named "missing"/,
    )
    memory.close()
  })
})
