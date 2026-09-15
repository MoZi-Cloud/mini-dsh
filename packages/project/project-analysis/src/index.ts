/**
 * Repository indexing: the orchestrator that turns one worktree capture into
 * a project memory snapshot. It resolves the git baseline, collects source
 * files, runs the syntactic pass (and, by default, the TypeChecker pass),
 * writes symbols, imports, the call graph, type references, and the
 * `project_objects` tree in one transaction, and records a run event.
 *
 * @module @deepseek-ai/dsh-project-analysis
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import ts from 'typescript'
import { ProjectMemoryError } from '@deepseek-ai/dsh-project-memory'
import type {
  ExtractionLevel,
  FileId,
  ProjectMemory,
  ProjectObjectId,
  RepositoryId,
  SnapshotId,
  SnapshotKind,
  SymbolVersionId,
} from '@deepseek-ai/dsh-project-memory'
import { readHeadCommit } from './git.ts'
import { collectDocuments, collectSourceFiles, languageOf } from './files.ts'
import { DYNAMIC_CALLEE, extractSyntacticFile } from './syntactic.ts'
import { countSyntacticDiagnostics, extractSemanticFile } from './semantic.ts'
import { extractMarkdownStructure } from './docs.ts'

/** Options for one repository index run. */
export interface IndexRepositoryOptions {
  /** Worktree root to index. */
  readonly root: string
  /** Repository slug; defaults to the root's base name. */
  readonly slug?: string | undefined
  /** How the snapshot is captured. */
  readonly snapshotKind: SnapshotKind
  /** Required commit for `pinned` snapshots; otherwise resolved from HEAD. */
  readonly commitSha?: string | undefined
  /** Additional directory names to exclude from the walk. */
  readonly excludeDirNames?: readonly string[] | undefined
  /** Extractor level; defaults to `typechecker`. */
  readonly level?: ExtractionLevel | undefined
  /** Index Markdown documents (files, content, heading outline); default `true`. */
  readonly includeDocuments?: boolean | undefined
}

/** The outcome of one repository index run. */
export interface IndexReport {
  readonly repositoryId: RepositoryId
  readonly snapshotId: SnapshotId
  readonly commitSha: string | undefined
  readonly dirty: boolean
  readonly fileCount: number
  readonly documentCount: number
  readonly documentHeadingCount: number
  readonly symbolCount: number
  readonly callSiteCount: number
  readonly resolvedCalls: number
  readonly externalCalls: number
  readonly unresolvedCalls: number
  readonly dynamicCalls: number
  readonly typeReferenceCount: number
  readonly projectObjectCount: number
  readonly diagnosticCount: number
}

/** One call edge awaiting semantic resolution, keyed to merge with checker output. */
interface PendingCall {
  readonly resolution: 'resolved' | 'unresolved' | 'external'
  readonly calleeFile: string | undefined
  readonly calleeQualifiedName: string | undefined
}

/**
 * Index one worktree into the project memory store.
 *
 * The run captures a new snapshot (append-only; prior snapshots stay),
 * extracts symbols and the call graph, resolves call edges with the
 * TypeChecker unless `level` is `syntactic`, materializes the
 * `project_objects` tree, and commits everything in one transaction — a
 * failure leaves no partial snapshot.
 * @param memory - the store to write to.
 * @param options - the capture and extraction settings.
 * @returns the report describing what was captured and resolved.
 */
export function indexRepository(memory: ProjectMemory, options: IndexRepositoryOptions): IndexReport {
  const root = resolve(options.root)
  const level = options.level ?? 'typechecker'
  const commitSha = resolveCommitSha(root, options)
  const slug = options.slug ?? basename(root)
  const files = collectSourceFiles(root, { excludeDirNames: options.excludeDirNames })
  const documents = options.includeDocuments === false
    ? []
    : collectDocuments(root, { excludeDirNames: options.excludeDirNames })
  const parsed = files.map(file => ({
    file,
    extract: extractSyntacticFile(
      ts.createSourceFile(file.absolutePath, file.text, ts.ScriptTarget.Latest, true),
    ),
  }))

  const semanticCalls = new Map<string, PendingCall>()
  const typeReferences: {
    file: string
    line: number
    referencedFile: string
    referencedQualifiedName: string
  }[] = []
  let diagnosticCount = 0
  if (level === 'typechecker' && files.length > 0) {
    const program = ts.createProgram(
      files.map(file => file.absolutePath),
      {
        noEmit: true,
        skipLibCheck: true,
        allowJs: false,
        allowImportingTsExtensions: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    )
    diagnosticCount = countSyntacticDiagnostics(program)
    const indexedAbsolute = new Set(files.map(file => file.absolutePath))
    const relativeOf = (absolutePath: string): string => relative(root, absolutePath).split('\\').join('/')
    for (const { file } of parsed) {
      // Walk the program's own SourceFile: the checker only resolves nodes it
      // parsed itself, so the separately-parsed syntactic AST is not usable here.
      const programSource = program.getSourceFile(file.absolutePath)
      if (programSource === undefined) continue
      const facts = extractSemanticFile(program, programSource, relativeOf, absolutePath => indexedAbsolute.has(absolutePath))
      for (const call of facts.calls) {
        semanticCalls.set(`${file.path}:${call.line}:${call.column}`, {
          resolution: call.resolution === 'dynamic' ? 'unresolved' : call.resolution,
          calleeFile: call.calleeFile,
          calleeQualifiedName: call.calleeQualifiedName,
        })
      }
      for (const reference of facts.typeReferences) {
        typeReferences.push({
          file: file.path,
          line: reference.line,
          referencedFile: reference.referencedFile,
          referencedQualifiedName: reference.referencedQualifiedName,
        })
      }
    }
  }

  return memory.transaction(() => {
    const repository = memory.upsertRepository({ slug, localPath: root })
    const snapshot = memory.insertSnapshot({
      repositoryId: repository.id,
      snapshotKind: options.snapshotKind,
      commitSha,
      dirty: options.snapshotKind === 'worktree',
    })

    const symbolVersionIds = new Map<string, SymbolVersionId>()
    // Overload sets and declaration merging map several declarations to one
    // qualified name; disambiguate with an occurrence ordinal so every
    // declaration keeps its own symbol version.
    const occurrences = new Map<string, number>()
    // Pass 1 — files, imports, and every symbol, so the complete symbol
    // index exists before any edge references it (files are visited in path
    // order, and forward imports would otherwise miss their callee).
    const indexed: {
      readonly file: (typeof parsed)[number]['file']
      readonly extract: (typeof parsed)[number]['extract']
      readonly fileRowId: FileId
    }[] = []
    for (const { file, extract } of parsed) {
      const contentId = memory.putContent(file.text)
      const fileRow = memory.insertFile({
        snapshotId: snapshot.id,
        path: file.path,
        language: languageOf(file.path),
        byteLength: file.byteLength,
        contentId,
      })
      indexed.push({ file, extract, fileRowId: fileRow.id })
      for (const imported of extract.imports) {
        memory.insertImport({ fileId: fileRow.id, ...imported })
      }
      for (const symbol of extract.symbols) {
        const base = stableSymbolKey(file.path, symbol.qualifiedName)
        const ordinal = (occurrences.get(base) ?? 0) + 1
        occurrences.set(base, ordinal)
        const stableKey = ordinal === 1 ? base : `${base}#${ordinal}`
        const identity = memory.upsertSymbol(repository.id, stableKey)
        const version = memory.insertSymbolVersion({
          symbolId: identity.id,
          snapshotId: snapshot.id,
          fileId: fileRow.id,
          name: symbol.name,
          qualifiedName: symbol.qualifiedName,
          symbolKind: symbol.symbolKind,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signatureText: symbol.signatureText,
          isExported: symbol.isExported,
          isAsync: symbol.isAsync,
          isStatic: symbol.isStatic,
          // Signature, flags, and location facts come from the AST pass; the
          // TypeChecker pass only resolves call edges and type references.
          extractionLevel: 'syntactic',
        })
        symbolVersionIds.set(stableKey, version.id)
      }
    }
    // Pass 2 — call edges over the complete symbol index.
    for (const { file, extract, fileRowId } of indexed) {
      for (const call of extract.calls) {
        const callerId =
          call.callerQualifiedName === undefined
            ? undefined
            : symbolVersionIds.get(stableSymbolKey(file.path, call.callerQualifiedName))
        const semantic = semanticCalls.get(`${file.path}:${call.line}:${call.column}`)
        const calleeId =
          semantic?.resolution === 'resolved' &&
          semantic.calleeFile !== undefined &&
          semantic.calleeQualifiedName !== undefined
            ? symbolVersionIds.get(stableSymbolKey(semantic.calleeFile, semantic.calleeQualifiedName))
            : undefined
        // `resolved` is reserved for linked edges: a checker resolution to a
        // declaration the symbol index does not carry (a parameter, a local
        // variable) degrades to unresolved rather than asserting a link that
        // does not exist.
        const resolution =
          calleeId !== undefined
            ? 'resolved'
            : call.calleeName === DYNAMIC_CALLEE
              ? 'dynamic'
              : semantic?.resolution === 'external'
                ? 'external'
                : 'unresolved'
        memory.insertCallSite({
          snapshotId: snapshot.id,
          fileId: fileRowId,
          line: call.line,
          column: call.column,
          callerSymbolVersionId: callerId,
          calleeName: call.calleeName,
          calleeSymbolVersionId: calleeId,
          resolution,
          extractionLevel: semantic === undefined ? 'syntactic' : 'typechecker',
        })
      }
    }

    let documentHeadingCount = 0
    for (const document of documents) {
      const fileRow = memory.insertFile({
        snapshotId: snapshot.id,
        path: document.path,
        language: 'markdown',
        byteLength: document.byteLength,
        contentId: memory.putContent(document.text),
      })
      for (const heading of extractMarkdownStructure(document.text).headings) {
        memory.insertDocumentHeading({ fileId: fileRow.id, ...heading })
        documentHeadingCount += 1
      }
    }

    let typeReferenceCount = 0
    const fileRowIds = new Map<string, FileId>(indexed.map(({ file, fileRowId }) => [file.path, fileRowId]))
    for (const reference of typeReferences) {
      const referencedId = symbolVersionIds.get(stableSymbolKey(reference.referencedFile, reference.referencedQualifiedName))
      const fileId = fileRowIds.get(reference.file)
      if (referencedId === undefined || fileId === undefined) continue
      memory.insertSymbolReference({
        snapshotId: snapshot.id,
        fileId,
        line: reference.line,
        referencingSymbolVersionId: undefined,
        referencedSymbolVersionId: referencedId,
        referenceKind: 'type',
      })
      typeReferenceCount += 1
    }

    const projectObjectCount = insertProjectObjects(memory, repository.id, snapshot.id, root, parsed, documents, symbolVersionIds)

    const stats = memory.snapshotStats(snapshot.id)
    const report: IndexReport = {
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      commitSha,
      dirty: snapshot.dirty,
      fileCount: stats.files,
      documentCount: stats.documents,
      documentHeadingCount,
      symbolCount: stats.symbols,
      callSiteCount: stats.callSites,
      resolvedCalls: stats.resolvedCalls,
      externalCalls: stats.externalCalls,
      unresolvedCalls: stats.unresolvedCalls,
      dynamicCalls: stats.dynamicCalls,
      typeReferenceCount,
      projectObjectCount,
      diagnosticCount,
    }
    memory.recordRunEvent(repository.id, 'index-completed', report)
    return report
  })
}

/** The repository-wide stable key of one symbol identity. */
function stableSymbolKey(path: string, qualifiedName: string): string {
  return `symbol:${path}:${qualifiedName}`
}

function resolveCommitSha(root: string, options: IndexRepositoryOptions): string | undefined {
  if (options.snapshotKind === 'pinned') {
    if (options.commitSha === undefined) {
      throw new ProjectMemoryError('invalid-argument', 'a pinned snapshot requires an explicit commitSha')
    }
    return options.commitSha
  }
  const head = readHeadCommit(root)
  if (options.snapshotKind === 'head' && head.commitSha === undefined) {
    throw new ProjectMemoryError(
      'invalid-argument',
      `no resolvable HEAD commit under "${root}"; index with snapshotKind "worktree" or provide a commitSha`,
    )
  }
  return head.commitSha ?? options.commitSha
}

function insertProjectObjects(
  memory: ProjectMemory,
  repositoryId: RepositoryId,
  snapshotId: SnapshotId,
  root: string,
  parsed: readonly { readonly file: { readonly path: string } }[],
  documents: readonly { readonly path: string }[],
  symbolVersionIds: ReadonlyMap<string, SymbolVersionId>,
): number {
  const workspace = memory.insertProjectObject({
    repositoryId,
    snapshotId,
    objectKind: 'workspace',
    stableKey: 'workspace',
    name: 'workspace',
  })
  const idsByStableKey = new Map<string, ProjectObjectId>([['workspace', workspace.id]])
  let count = 1
  const ensureObject = (input: {
    objectKind: 'package_group' | 'package'
    stableKey: string
    name: string
    parentId: ProjectObjectId
  }): ProjectObjectId => {
    const existing = idsByStableKey.get(input.stableKey)
    if (existing !== undefined) return existing
    const row = memory.insertProjectObject({ repositoryId, snapshotId, ...input })
    idsByStableKey.set(input.stableKey, row.id)
    count += 1
    return row.id
  }
  for (const { file } of parsed) {
    const segments = file.path.split('/')
    const fileName = segments[segments.length - 1]
    if (fileName === undefined) continue
    let parentId = workspace.id
    if (segments.length >= 3 && segments[0] === 'packages') {
      const groupPath = `packages/${segments[1]}`
      const groupParent = ensureObject({
        objectKind: 'package_group',
        stableKey: `group:${groupPath}`,
        name: groupPath,
        parentId: workspace.id,
      })
      const packagePath = `packages/${segments[1]}/${segments[2]}`
      parentId = ensureObject({
        objectKind: 'package',
        stableKey: `package:${packagePath}`,
        name: packageNameOf(root, packagePath),
        parentId: groupParent,
      })
    }
    const fileObject = memory.insertProjectObject({
      repositoryId,
      snapshotId,
      objectKind: 'file',
      stableKey: `file:${file.path}`,
      name: fileName,
      parentId,
    })
    count += 1
    const prefix = `symbol:${file.path}:`
    for (const [key, symbolVersionId] of symbolVersionIds) {
      if (!key.startsWith(prefix)) continue
      memory.insertProjectObject({
        repositoryId,
        snapshotId,
        objectKind: 'symbol',
        stableKey: key,
        name: key.slice(prefix.length),
        parentId: fileObject.id,
        symbolVersionId,
      })
      count += 1
    }
  }
  for (const document of documents) {
    memory.insertProjectObject({
      repositoryId,
      snapshotId,
      objectKind: 'file',
      stableKey: `file:${document.path}`,
      name: document.path.split('/').pop() ?? document.path,
      parentId: workspace.id,
    })
    count += 1
  }
  return count
}

function packageNameOf(root: string, packagePath: string): string {
  const manifestPath = resolve(root, packagePath, 'package.json')
  if (existsSync(manifestPath)) {
    try {
      const name = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }).name
      if (typeof name === 'string' && name !== '') return name
    } catch {
      // Unparseable manifests fall back to the directory name.
    }
  }
  return packagePath.split('/').pop() ?? packagePath
}
