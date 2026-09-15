import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { collectSourceFiles, languageOf } from '../src/files.ts'
import { DYNAMIC_CALLEE, extractSyntacticFile } from '../src/syntactic.ts'

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
}

describe('extractSyntacticFile', () => {
  it('recovers module symbols with kinds, signatures, and flags', () => {
    const source = parse(
      'demo.ts',
      [
        "import { join } from 'node:path'",
        'import type { Options } from "./options.ts"',
        'export interface Options { mode: string }',
        'export type Result = number',
        'export enum Color { Red, Blue }',
        'export const LIMIT = 10',
        'export async function run(input: string): Promise<number> {',
        '  return compute(input, LIMIT)',
        '}',
        'function compute(input: string, limit: number): number {',
        '  console.log(input)',
        '  return input.length + limit',
        '}',
        'class Service {',
        '  static registry = new Map()',
        '  private cache?: Options',
        '  get size(): number { return 1 }',
        '  async load(): Promise<void> {}',
        '}',
      ].join('\n'),
    )
    const extract = extractSyntacticFile(source)
    const names = extract.symbols.map(symbol => `${symbol.qualifiedName}:${symbol.symbolKind}`)
    expect(names).toEqual([
      'Options:interface',
      'Result:type_alias',
      'Color:enum',
      'Color.Red:enum_member',
      'Color.Blue:enum_member',
      'LIMIT:variable',
      'run:function',
      'compute:function',
      'Service:class',
      'Service.registry:property',
      'Service.cache:property',
      'Service.size:getter',
      'Service.load:method',
    ])
    const run = extract.symbols.find(symbol => symbol.name === 'run')!
    expect(run.isExported).toBe(true)
    expect(run.isAsync).toBe(true)
    expect(run.signatureText).toBe('run(input: string): Promise<number>')
    const compute = extract.symbols.find(symbol => symbol.name === 'compute')!
    expect(compute.isExported).toBe(false)
    const load = extract.symbols.find(symbol => symbol.qualifiedName === 'Service.load')!
    expect(load.isAsync).toBe(true)
    expect(load.isStatic).toBe(false)
    expect(extract.imports).toMatchObject([
      { moduleSpecifier: 'node:path', isTypeOnly: false },
      { moduleSpecifier: './options.ts', isTypeOnly: true },
    ])
  })

  it('records call sites with dotted callee names and enclosing callers', () => {
    const source = parse(
      'demo.ts',
      ['export function outer() {', '  inner()', '  console.log("x")', '  const table: Record<string, () => void> = {}', '  table[getKey()]()', '}', 'function inner() {}', 'function getKey(): string { return "k" }'].join('\n'),
    )
    const extract = extractSyntacticFile(source)
    const calls = extract.calls.map(call => `${call.calleeName}@${call.line}:${call.callerQualifiedName}`)
    expect(calls).toContainEqual('inner@2:outer')
    expect(calls).toContainEqual('console.log@3:outer')
    expect(calls).toContainEqual('getKey@5:outer')
    // The computed call target has no printable name and is recorded dynamic.
    expect(calls).toContainEqual(`${DYNAMIC_CALLEE}@5:outer`)
    expect(extract.calls.every(call => call.column >= 1)).toBe(true)
  })

  it('leaves top-level calls without an enclosing declaration caller-less', () => {
    const source = parse('demo.ts', 'setup()\n')
    expect(extractSyntacticFile(source).calls).toMatchObject([{ calleeName: 'setup', callerQualifiedName: undefined }])
  })
})

describe('collectSourceFiles', () => {
  it('collects TypeScript sources deterministically while skipping excluded trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-project-analysis-files-'))
    try {
      writeFileSync(join(root, 'b.ts'), 'export const b = 1\n')
      writeFileSync(join(root, 'a.mts'), 'export const a = 1\n')
      writeFileSync(join(root, 'readme.md'), 'not source\n')
      mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
      writeFileSync(join(root, 'node_modules/pkg/index.ts'), 'skipped\n')
      mkdirSync(join(root, 'lib'), { recursive: true })
      writeFileSync(join(root, 'lib/gen.ts'), 'skipped\n')
      mkdirSync(join(root, 'src/nested'), { recursive: true })
      writeFileSync(join(root, 'src/nested/deep.ts'), 'export const deep = 1\n')
      const files = collectSourceFiles(root)
      expect(files.map(file => file.path)).toEqual(['a.mts', 'b.ts', 'src/nested/deep.ts'])
      expect(files[0]).toMatchObject({ text: 'export const a = 1\n', byteLength: 19 })
      const withCustom = collectSourceFiles(root, { excludeDirNames: ['nested'] })
      expect(withCustom.map(file => file.path)).toEqual(['a.mts', 'b.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('maps extensions to language tags', () => {
    expect(languageOf('a.ts')).toBe('typescript')
    expect(languageOf('a.d.ts')).toBe('typescript-declaration')
    expect(languageOf('a.mts')).toBe('typescript-module')
    expect(languageOf('a.cts')).toBe('typescript-commonjs')
  })
})
