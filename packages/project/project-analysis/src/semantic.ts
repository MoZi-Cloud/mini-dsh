/**
 * Semantic extraction: the TypeChecker pass that resolves each recorded call
 * expression to its declaring symbol and each type reference to the indexed
 * type it names. This is the resolver behind the `typechecker` extraction
 * level — it turns syntactic call names into graph edges.
 *
 * @module @deepseek-ai/dsh-project-analysis/semantic
 */

import ts from 'typescript'

/** The semantic resolution of one call position. */
export interface SemanticCallResolution {
  readonly line: number
  readonly column: number
  readonly resolution: 'resolved' | 'unresolved' | 'external' | 'dynamic'
  /** Repository file of the callee declaration, when resolved to an indexed file. */
  readonly calleeFile: string | undefined
  /** Qualified name of the callee declaration, when resolved to an indexed file. */
  readonly calleeQualifiedName: string | undefined
}

/** One type reference resolved to an indexed declaration. */
export interface SemanticTypeReference {
  readonly line: number
  /** Repository file of the referenced type declaration. */
  readonly referencedFile: string
  /** Qualified name of the referenced type declaration. */
  readonly referencedQualifiedName: string
}

/** The combined per-program extraction result. */
export interface SemanticFacts {
  readonly calls: readonly SemanticCallResolution[]
  readonly typeReferences: readonly SemanticTypeReference[]
  /** Count of syntactic diagnostics across the program's source files. */
  readonly diagnosticCount: number
}

/**
 * Resolve call and type-reference facts for the given source files with the
 * program's TypeChecker.
 *
 * Call positions match the syntactic pass exactly (one-based line/column of
 * the call expression start). A callee resolves when its declaring symbol's
 * declaration lives in one of `indexedRoots`; a declaration in a default
 * library or dependency file resolves as `external`; anything else is
 * `unresolved`; syntactically dynamic callees stay `dynamic`.
 * @param program - the compiled program.
 * @param sourceFile - the parsed file the positions belong to.
 * @param relativeOf - maps an absolute path to its repository-relative form.
 * @param isIndexed - decides whether an absolute path belongs to the indexed set.
 * @returns the resolved facts for that file.
 */
export function extractSemanticFile(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  relativeOf: (absolutePath: string) => string,
  isIndexed: (absolutePath: string) => boolean,
): Pick<SemanticFacts, 'calls' | 'typeReferences'> {
  const checker = program.getTypeChecker()
  const calls: SemanticCallResolution[] = []
  const typeReferences: SemanticTypeReference[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      calls.push(resolveCall(checker, node, position, relativeOf, isIndexed))
    } else if (ts.isTypeReferenceNode(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      const reference = resolveTypeReference(checker, node, position, relativeOf, isIndexed)
      if (reference !== undefined) typeReferences.push(reference)
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return { calls, typeReferences }
}

/**
 * Count syntactic diagnostics for the files of one program.
 * @param program - the compiled program.
 * @returns the total syntactic diagnostic count.
 */
export function countSyntacticDiagnostics(program: ts.Program): number {
  // The syntactic set is the cheap signal that files parsed at all; the
  // semantic set is not computed here because extraction must stay resilient
  // to type errors in unindexed dependencies.
  let count = 0
  for (const source of program.getSourceFiles()) {
    count += program.getSyntacticDiagnostics(source).length
  }
  return count
}

function resolveCall(
  checker: ts.TypeChecker,
  node: ts.CallExpression,
  position: ts.LineAndCharacter,
  relativeOf: (absolutePath: string) => string,
  isIndexed: (absolutePath: string) => boolean,
): SemanticCallResolution {
  const base = { line: position.line + 1, column: position.character + 1 }
  if (isDynamicCallee(node.expression)) {
    return { ...base, resolution: 'dynamic', calleeFile: undefined, calleeQualifiedName: undefined }
  }
  const symbol = aliasedSymbol(checker, checker.getSymbolAtLocation(node.expression))
  const declaration = symbol?.getDeclarations()?.[0]
  if (symbol === undefined || declaration === undefined) {
    return { ...base, resolution: 'unresolved', calleeFile: undefined, calleeQualifiedName: undefined }
  }
  const declarationFile = declaration.getSourceFile().fileName
  if (!isIndexed(declarationFile)) {
    return { ...base, resolution: 'external', calleeFile: undefined, calleeQualifiedName: undefined }
  }
  return {
    ...base,
    resolution: 'resolved',
    calleeFile: relativeOf(declarationFile),
    calleeQualifiedName: qualifiedNameOf(checker, symbol),
  }
}

function resolveTypeReference(
  checker: ts.TypeChecker,
  node: ts.TypeReferenceNode,
  position: ts.LineAndCharacter,
  relativeOf: (absolutePath: string) => string,
  isIndexed: (absolutePath: string) => boolean,
): SemanticTypeReference | undefined {
  const symbol = aliasedSymbol(checker, checker.getSymbolAtLocation(node.typeName))
  const declaration = symbol?.getDeclarations()?.[0]
  if (symbol === undefined || declaration === undefined) return undefined
  const declarationFile = declaration.getSourceFile().fileName
  if (!isIndexed(declarationFile)) return undefined
  return {
    line: position.line + 1,
    referencedFile: relativeOf(declarationFile),
    referencedQualifiedName: qualifiedNameOf(checker, symbol),
  }
}

/**
 * Unwrap an import-alias symbol to the declaration it re-exports. References
 * through `import { x } from ...` resolve to the alias first; without this
 * unwrap the callee's file would be the importing file and every cross-file
 * edge would misresolve.
 * @param checker - the program's type checker.
 * @param symbol - the symbol found at the reference location, if any.
 * @returns the underlying declaration symbol, or the original when not an alias.
 */
function aliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (symbol === undefined) return undefined
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const target = checker.getAliasedSymbol(symbol)
    // Unresolved imports alias to a missing-symbol marker with no name.
    return target.getName() === 'unknown' ? symbol : target
  }
  return symbol
}

function qualifiedNameOf(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  // The checker's own symbol-name walk (parents joined by '.') matches the
  // syntactic pass's qualified-name construction for module-scope symbols.
  const name = checker.symbolToString(symbol)
  return name === '' ? symbol.getName() : name
}

function isDynamicCallee(expression: ts.Expression): boolean {
  // Mirrors the syntactic pass: only identifier and property-access callees
  // are nameable; every other callee shape is dynamic.
  return !(ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression))
}
