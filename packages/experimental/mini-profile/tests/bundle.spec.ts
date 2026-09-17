/** The mini bundle's declared Cordis row and its manifest wiring. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-experimental-mini-profile bundle', () => {
  it('mounts exactly the Project Ledger capability row over its declared patch', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['project-ledger', '@deepseek-ai/dsh-experimental-mini-profile'],
    ])
    // The patch resolves the deployment-owned path as an unevaluated `!!js`
    // expression node: env override, then the dsh home. The plugin itself
    // declares no default.
    expect(rows[0]?.config).toEqual({
      ledgerPath: {
        __jsExpr: "process.env.DSH_MINI_LEDGER_PATH ?? dshHomePath('project-ledger/ledger.sqlite')",
      },
    })
  })

  it('declares the ledger capability and its store as dependencies', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      bin?: unknown
    }
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-experimental-project-ledger',
      '@deepseek-ai/dsh-experimental-project-ledger-sqlite',
      '@deepseek-ai/schemastery',
    ])
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-brand',
    ])
    expect(manifest.peerDependencies).toEqual({ '@deepseek-ai/cordis': 'workspace:^' })
    expect(manifest.bin).toBeUndefined()
  })
})
