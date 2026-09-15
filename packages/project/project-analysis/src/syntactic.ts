/**
 * Syntactic extraction: the AST-level pass that recovers declarations,
 * imports, and call expressions from one TypeScript source file without type
 * resolution. Every fact this pass produces is later refined — never
 * contradicted — by the TypeChecker pass in `semantic.ts`.
 *
 * @module @deepseek-ai/dsh-project-analysis/syntactic
 */

import ts from 'typescript'

/** Placeholder callee name recorded for call targets the AST cannot name. */
export const DYNAMIC_CALLEE = '<dynamic>'

/** One declaration recovered from the AST. */
export interface SyntacticSymbol {
  readonly name: string
  readonly qualifiedName: string
  readonly symbolKind:
    | 'function' | 'method' | 'class' | 'interface' | 'type_alias' | 'enum'
    | 'enum_member' | 'property' | 'getter' | 'setter' | 'variable'
  readonly startLine: number
  readonly endLine: number
  readonly signatureText: string
  readonly isExported: boolean
  readonly isAsync: boolean
  readonly isStatic: boolean
}

/** One call expression recovered from the AST. */
export interface SyntacticCall {
  readonly calleeName: string
  readonly line: number
  readonly column: number
  /** Qualified name of the innermost enclosing recorded declaration, if any. */
  readonly callerQualifiedName: string | undefined
}

/** One module import recovered from the AST. */
export interface SyntacticImport {
  readonly moduleSpecifier: string
  readonly isTypeOnly: boolean
  readonly line: number
}

/** The combined per-file extraction result. */
export interface SyntacticFileExtract {
  readonly symbols: readonly SyntacticSymbol[]
  readonly calls: readonly SyntacticCall[]
  readonly imports: readonly SyntacticImport[]
}

/**
 * Extract declarations, calls, and imports from one parsed source file.
 *
 * Declarations are the named members of the module and its types: functions,
 * classes and their members, interfaces, type aliases, enums and members,
 * accessors, and exported variable declarations. Call expressions record the
 * callee as a dotted name when the AST prints one, {@link DYNAMIC_CALLEE}
 * otherwise. All positions are one-based lines and columns.
 * @param source - the parsed source file.
 * @returns the extracted facts.
 */
export function extractSyntacticFile(source: ts.SourceFile): SyntacticFileExtract {
  const symbols: SyntacticSymbol[] = []
  const calls: SyntacticCall[] = []
  const imports: SyntacticImport[] = []
  const scope: string[] = []
  const visit = (node: ts.Node): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source))
    if (ts.isImportDeclaration(node)) {
      imports.push({
        moduleSpecifier: node.moduleSpecifier.getText(source).slice(1, -1),
        isTypeOnly: node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
        line: line.line + 1,
      })
    } else if (isDeclaration(node)) {
      const name = declarationName(node, source)
      if (name !== undefined) {
        symbols.push({
          name,
          qualifiedName: [...scope, name].join('.'),
          symbolKind: declarationKind(node),
          startLine: line.line + 1,
          endLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
          signatureText: signatureText(node, name, source),
          isExported: isExportedNode(node),
          isAsync: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
          isStatic: hasModifier(node, ts.SyntaxKind.StaticKeyword),
        })
      }
      scope.push(name ?? '<anonymous>')
      node.forEachChild(visit)
      scope.pop()
      return
    } else if (ts.isCallExpression(node)) {
      calls.push({
        calleeName: printableCallee(node.expression, source),
        line: line.line + 1,
        column: line.character + 1,
        callerQualifiedName: scope.length === 0 ? undefined : scope.join('.'),
      })
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return { symbols, calls, imports }
}

function isDeclaration(node: ts.Node): node is DeclarationNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isEnumMember(node) ||
    isRecordedVariable(node)
  )
}

type DeclarationNode =
  | ts.FunctionDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration
  | ts.EnumDeclaration | ts.MethodDeclaration | ts.PropertyDeclaration
  | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.EnumMember | ts.VariableDeclaration

function isRecordedVariable(node: ts.Node): node is ts.VariableDeclaration {
  // Variables enter the index only when exported: the module surface is what
  // the memory store is for, and recording every local would bury it.
  return ts.isVariableDeclaration(node) && isExportedNode(node)
}

function declarationName(node: DeclarationNode, source: ts.SourceFile): string | undefined {
  if (ts.isVariableDeclaration(node)) return node.name.getText(source)
  const { name } = node
  return name === undefined ? undefined : name.getText(source)
}

function declarationKind(node: DeclarationNode): SyntacticSymbol['symbolKind'] {
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type_alias'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isEnumMember(node)) return 'enum_member'
  if (ts.isMethodDeclaration(node)) return 'method'
  if (ts.isPropertyDeclaration(node)) return 'property'
  if (ts.isGetAccessorDeclaration(node)) return 'getter'
  if (ts.isSetAccessorDeclaration(node)) return 'setter'
  return 'variable'
}

function signatureText(node: DeclarationNode, name: string, source: ts.SourceFile): string {
  const isCallableLike =
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  if (isCallableLike) {
    const parameters = node.parameters.map(parameter => parameter.getText(source)).join(', ')
    const returnType = node.type === undefined ? '' : `: ${node.type.getText(source)}`
    return `${name}(${parameters})${returnType}`
  }
  if (ts.isVariableDeclaration(node) && node.type !== undefined) {
    return `${name}: ${node.type.getText(source)}`
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return `${name} = ${node.type.getText(source)}`
  }
  return name
}

function isExportedNode(node: ts.Node): boolean {
  // VariableDeclaration carries the export on its grandparent
  // VariableStatement; class members carry it on the parent declaration.
  // A SourceFile's runtime parent is undefined despite the non-optional type,
  // so reachability is guarded by kind, not by undefined checks.
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) return true
  const { parent } = node
  if (ts.isSourceFile(parent)) return false
  if (hasModifier(parent, ts.SyntaxKind.ExportKeyword)) return true
  return !ts.isSourceFile(parent.parent) && hasModifier(parent.parent, ts.SyntaxKind.ExportKeyword)
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (node.modifiers?.some(modifier => modifier.kind === kind) ?? false)
}

function printableCallee(expression: ts.Expression, source: ts.SourceFile): string {
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const text = expression.getText(source)
    // Dotted names are kept whole; whitespace only appears in exotic
    // formatting, and collapsing it keeps callee names stable.
    return text.includes(' ') ? text.replace(/\s+/g, '') : text
  }
  return DYNAMIC_CALLEE
}
