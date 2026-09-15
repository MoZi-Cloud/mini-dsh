import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectMemory } from '@deepseek-ai/dsh-project-memory'
import { extractMarkdownStructure } from '../src/docs.ts'
import { collectDocuments } from '../src/files.ts'
import { indexRepository } from '../src/index.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-analysis-docs-'))
  roots.push(root)
  return root
}

describe('extractMarkdownStructure', () => {
  it('recovers the ATX outline with levels and one-based lines', () => {
    const structure = extractMarkdownStructure(
      ['# Title', '', '## Section', 'body', '### Nested', '', '## Another', ''].join('\n'),
    )
    expect(structure.title).toBe('Title')
    expect(structure.headings).toEqual([
      { level: 1, line: 1, text: 'Title' },
      { level: 2, line: 3, text: 'Section' },
      { level: 3, line: 5, text: 'Nested' },
      { level: 2, line: 7, text: 'Another' },
    ])
  })

  it('skips frontmatter and fenced code blocks', () => {
    const structure = extractMarkdownStructure(
      ['---', 'description: "# not a heading"', '---', '', '# Real', '', '```ts', '// # not either', '```', '', '~~~', '# fenced', '~~~', '', '## After'].join('\n'),
    )
    expect(structure.title).toBe('Real')
    expect(structure.headings.map(heading => heading.text)).toEqual(['Real', 'After'])
  })

  it('reports no title for documents without a level-1 heading', () => {
    const structure = extractMarkdownStructure(['## Only subsection', ''].join('\n'))
    expect(structure.title).toBeUndefined()
    expect(structure.headings).toEqual([{ level: 2, line: 1, text: 'Only subsection' }])
  })

  it('ignores empty and closing-hash-only headings', () => {
    const structure = extractMarkdownStructure(['#', '##   ', '# Kept ###', ''].join('\n'))
    expect(structure.headings).toEqual([{ level: 1, line: 3, text: 'Kept' }])
  })
})

describe('collectDocuments', () => {
  it('collects markdown files deterministically while skipping excluded trees', () => {
    const root = tmpRoot()
    writeFileSync(join(root, 'b.md'), '# B\n')
    writeFileSync(join(root, 'a.md'), '# A\n')
    writeFileSync(join(root, 'README.txt'), 'not markdown\n')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'node_modules/skipped.md'), '# skipped\n')
    mkdirSync(join(root, 'keepme'), { recursive: true })
    writeFileSync(join(root, 'keepme/c.md'), '# C\n')
    expect(collectDocuments(root).map(document => document.path)).toEqual(['a.md', 'b.md', 'keepme/c.md'])
    // Additional exclusions merge over the built-in set; they cannot remove it.
    expect(collectDocuments(root, { excludeDirNames: ['keepme'] }).map(document => document.path)).toEqual([
      'a.md',
      'b.md',
    ])
  })
})

describe('indexRepository documents', () => {
  function docRepo(): string {
    const root = tmpRoot()
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/README.md'), ['# Guide', '', '## Install', 'steps', ''].join('\n'))
    writeFileSync(join(root, 'main.ts'), 'export function main(): void {}\n')
    return root
  }

  it('stores documents, content, and the heading outline by default', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const report = indexRepository(memory, { root: docRepo(), snapshotKind: 'worktree' })
    expect(report.documentCount).toBe(1)
    expect(report.documentHeadingCount).toBe(2)
    expect(report.fileCount).toBe(2)
    const documents = memory.findFilesByLanguage(report.snapshotId, 'markdown')
    expect(documents.map(document => document.path)).toEqual(['docs/README.md'])
    const headings = memory.findDocumentHeadings(documents[0]!.id)
    expect(headings).toMatchObject([
      { level: 1, line: 1, text: 'Guide' },
      { level: 2, line: 3, text: 'Install' },
    ])
    const content = memory.getContent(documents[0]!.contentId!)
    expect(content?.text).toContain('# Guide')
    const docObject = memory.findProjectObjectByStableKey(report.snapshotId, 'file:docs/README.md')
    expect(docObject).toBeDefined()
    memory.close()
  })

  it('skips documents when explicitly disabled', async () => {
    const memory = await ProjectMemory.open(':memory:')
    const report = indexRepository(memory, { root: docRepo(), snapshotKind: 'worktree', includeDocuments: false })
    expect(report.documentCount).toBe(0)
    expect(memory.findFilesByLanguage(report.snapshotId, 'markdown')).toEqual([])
    memory.close()
  })
})
