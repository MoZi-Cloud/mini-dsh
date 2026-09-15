/**
 * Source and document enumeration for repository indexing: deterministic
 * walks that collect TypeScript sources and Markdown documents while
 * skipping build outputs and vendor trees.
 *
 * @module @deepseek-ai/dsh-project-analysis/files
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Directory names never descended into. */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  '.git',
  '.dsh-build',
  'node_modules',
  'lib',
  'dist',
  'build',
  'coverage',
]

/** One collected file with its repository-relative path and text. */
export interface CollectedFile {
  /** Repository-relative POSIX-style path. */
  readonly path: string
  /** Absolute filesystem path. */
  readonly absolutePath: string
  /** File size in UTF-8 bytes. */
  readonly byteLength: number
  /** File text. */
  readonly text: string
}

/** Options controlling a walk. */
export interface CollectFilesOptions {
  /** Additional directory names to skip, merged over {@link DEFAULT_EXCLUDED_DIRS}. */
  readonly excludeDirNames?: readonly string[] | undefined
}

/**
 * Collect TypeScript source files under a root, in deterministic path order.
 *
 * Extensions `.ts`, `.mts`, and `.cts` are collected (declaration files
 * included — the TypeChecker pass reads them); excluded directories are
 * skipped entirely.
 * @param root - the worktree root to walk.
 * @param options - exclusion overrides.
 * @returns the collected files sorted by repository-relative path.
 */
export function collectSourceFiles(root: string, options: CollectFilesOptions = {}): CollectedFile[] {
  return collectMatching(root, /\.(ts|mts|cts)$/, /$^/, options)
}

/**
 * Collect Markdown documents under a root, in deterministic path order.
 * @param root - the worktree root to walk.
 * @param options - exclusion overrides.
 * @returns the collected documents sorted by repository-relative path.
 */
export function collectDocuments(root: string, options: CollectFilesOptions = {}): CollectedFile[] {
  return collectMatching(root, /\.md$/, /$^/, options)
}

function collectMatching(
  root: string,
  include: RegExp,
  exclude: RegExp,
  options: CollectFilesOptions,
): CollectedFile[] {
  const excluded = new Set([...DEFAULT_EXCLUDED_DIRS, ...(options.excludeDirNames ?? [])])
  const files: CollectedFile[] = []
  walk(root, root, excluded, include, exclude, files)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

function walk(
  root: string,
  dir: string,
  excluded: ReadonlySet<string>,
  include: RegExp,
  exclude: RegExp,
  out: CollectedFile[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) walk(root, join(dir, entry.name), excluded, include, exclude, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!include.test(entry.name) || exclude.test(entry.name)) continue
    const absolutePath = join(dir, entry.name)
    const text = readFileSync(absolutePath, 'utf8')
    out.push({
      path: relative(root, absolutePath).split(sep).join('/'),
      absolutePath,
      byteLength: Buffer.byteLength(text, 'utf8'),
      text,
    })
  }
}

/** Map a file path to the stored language tag. @param path - file path. @returns the language tag. */
export function languageOf(path: string): string {
  if (path.endsWith('.md')) return 'markdown'
  if (path.endsWith('.d.ts')) return 'typescript-declaration'
  if (path.endsWith('.mts')) return 'typescript-module'
  if (path.endsWith('.cts')) return 'typescript-commonjs'
  return 'typescript'
}
