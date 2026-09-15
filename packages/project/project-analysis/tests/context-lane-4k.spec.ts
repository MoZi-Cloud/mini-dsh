/**
 * The 4K context-lane gate. A deterministic, keyless benchmark: it
 * synthesizes a fixture repository, indexes it through the production
 * extractor path, then requires every representative context packet the
 * store can produce to fit the reviewed budget — zero overflowing packets.
 *
 * The lane definition this gate enforces: any single bounded retrieval that
 * would feed a worker's context (symbol lookup, callers-of, callees-of)
 * fits `CONTEXT_LANE_TOKEN_BUDGET` estimated tokens, with what did not fit
 * reported as elided sections rather than silently included. The budget is
 * a reviewed source constant; nothing in the environment can widen it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTEXT_LANE_TOKEN_BUDGET,
  ProjectMemory,
  buildContextPacket,
  type ContextPacket,
  type SnapshotId,
  type SymbolVersionRow,
} from '@deepseek-ai/dsh-project-memory'
import { indexRepository } from '../src/index.ts'

const FILE_COUNT = 24
const FUNCTIONS_PER_FILE = 10
const ROOT_DIR = 'packages/demo/lane/src'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Build the deterministic workload: one shared `probe` function every module
 * calls (a high-fan-in callee), per-module workers that call each other, and
 * library calls that stay external. Content is a pure function of the
 * indices — no randomness, no ambient input.
 */
function synthesizeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-lane-4k-'))
  roots.push(root)
  mkdirSync(join(root, ROOT_DIR), { recursive: true })
  writeFileSync(
    join(root, ROOT_DIR, 'probe.ts'),
    ['export function probe(input: string): number {', '  return input.length', '}', ''].join('\n'),
  )
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const lines: string[] = ["import { probe } from './probe.ts'"]
    for (let step = 0; step < FUNCTIONS_PER_FILE; step += 1) {
      lines.push(
        `export function mod${index}Step${step}(input: string): number {`,
        `  const base = probe(input) + ${index} + ${step}`,
        `  return mod${index}Step${(step + 1) % FUNCTIONS_PER_FILE}(input) + base`,
        '}',
      )
    }
    writeFileSync(join(root, ROOT_DIR, `mod${index}.ts`), `${lines.join('\n')}\n`)
  }
  return root
}

function allPackets(memory: ProjectMemory, snapshotId: SnapshotId): ContextPacket[] {
  const packets: ContextPacket[] = []
  const symbols = [
    ...memory.findSymbolVersionsByName(snapshotId, 'probe'),
    ...memory.findSymbolVersionsByName(snapshotId, 'mod0Step0'),
    ...memory.findSymbolVersionsByName(snapshotId, 'mod12Step5'),
  ]
  for (const symbol of symbols) {
    packets.push(buildContextPacket(memory, { kind: 'symbol', snapshotId, name: symbol.name }))
    packets.push(buildContextPacket(memory, { kind: 'callers', snapshotId, callee: symbol.id }))
    packets.push(buildContextPacket(memory, { kind: 'callees', snapshotId, caller: symbol.id }))
  }
  return packets
}

describe('4K context lane', () => {
  it('produces zero overflowing packets over the synthesized workload', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const root = synthesizeFixture()
    const report = indexRepository(memory, { root, snapshotKind: 'worktree', slug: 'lane-fixture' })
    expect(report.fileCount).toBe(FILE_COUNT + 1)
    expect(report.resolvedCalls).toBeGreaterThan(FILE_COUNT * FUNCTIONS_PER_FILE)

    const packets = allPackets(memory, report.snapshotId)
    expect(packets.length).toBeGreaterThan(0)
    const overflowing = packets.filter(packet => packet.overflow)
    expect(overflowing).toEqual([])
    const maxEstimate = Math.max(...packets.map(packet => packet.tokenEstimate))
    expect(maxEstimate).toBeLessThanOrEqual(CONTEXT_LANE_TOKEN_BUDGET)
    // The high-fan-in probe has far more callers than one lane can hold, so
    // elision must engage and still respect the budget.
    const probe: SymbolVersionRow = memory.findSymbolVersionsByName(report.snapshotId, 'probe')[0]!
    const probeCallers = buildContextPacket(memory, { kind: 'callers', snapshotId: report.snapshotId, callee: probe.id })
    expect(probeCallers.elidedSections.length).toBeGreaterThan(0)
    expect(probeCallers.tokenEstimate).toBeLessThanOrEqual(CONTEXT_LANE_TOKEN_BUDGET)
    memory.close()
  })

  it('holds the reviewed budget constant at 4096 tokens', () => {
    expect(CONTEXT_LANE_TOKEN_BUDGET).toBe(4096)
  })
})
