/**
 * Markdown document structure extraction: a dependency-free line scanner that
 * recovers the heading outline of an indexed document, skipping fenced code
 * blocks and YAML frontmatter so literal `#` lines inside them are not
 * mistaken for headings.
 *
 * @module @deepseek-ai/dsh-project-analysis/docs
 */

/** One ATX heading recovered from a document. */
export interface DocumentHeading {
  /** Heading level, 1 through 6. */
  readonly level: number
  /** One-based line of the heading. */
  readonly line: number
  /** Heading text without the leading hashes and surrounding whitespace. */
  readonly text: string
}

/** The extracted structure of one document. */
export interface DocumentStructure {
  /** Text of the first level-1 heading, or `undefined` when there is none. */
  readonly title: string | undefined
  /** Every heading outside code fences and frontmatter, in document order. */
  readonly headings: readonly DocumentHeading[]
}

const ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/

/**
 * Extract the heading outline of a Markdown document.
 *
 * Only ATX headings (`#` through `######`) are recognized. YAML frontmatter
 * (a leading `---` block) and fenced code blocks (``` or ~~~) are skipped;
 * setext headings are not recovered — the outline contract is ATX-only and
 * deterministic.
 * @param text - the full document text.
 * @returns the document title and heading outline.
 */
export function extractMarkdownStructure(text: string): DocumentStructure {
  const lines = text.split('\n')
  const headings: DocumentHeading[] = []
  let inFrontmatter = lines[0] !== undefined && lines[0].trim() === '---'
  let fence: string | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (inFrontmatter) {
      if (index > 0 && line.trim() === '---') inFrontmatter = false
      continue
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch !== null && fenceMatch[0] !== '') {
      const marker = (fenceMatch[1] ?? '').slice(0, 3)
      if (fence === undefined) fence = marker
      else if (fence === marker) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const heading = ATX.exec(line)
    if (heading === null) continue
    const [hashes, body] = [heading[1] ?? '', heading[2] ?? '']
    if (body === '' || hashes === '') continue
    headings.push({ level: hashes.length, line: index + 1, text: body })
  }
  const title = headings.find(heading => heading.level === 1)?.text
  return { title, headings }
}
