import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checksumSum } from '../src/math.mjs'

test('checksumSum adds two numbers', () => {
  assert.equal(checksumSum(2, 3), 5)
  assert.equal(checksumSum(-1, 1), 0)
})
