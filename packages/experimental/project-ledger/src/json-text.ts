/**
 * Input validation shared by the ledger's write seams: JSON-text fields that
 * must parse as a JSON object when present.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/json-text
 */

/**
 * Reject a JSON-text input that must parse as a JSON object when present —
 * arrays and the JSON `null` literal are not objects. The throwing seam
 * supplies its own error constructor, so each domain's callers keep catching
 * that domain's error.
 * @param field - the input name quoted in the error message.
 * @param value - the JSON text, or `undefined` when the field is absent.
 * @param makeError - builds the domain error the validation throws.
 * @throws whatever `makeError` returns, on invalid JSON or a non-object value.
 */
export function requireJsonObject(
  field: string,
  value: string | undefined,
  makeError: (message: string) => Error,
): void {
  if (value === undefined) return
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw makeError(`${field} must be valid JSON text`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw makeError(`${field} must be a JSON object`)
  }
}
