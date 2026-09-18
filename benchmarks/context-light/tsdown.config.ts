import { defineConfig } from 'tsdown'

/**
 * Compile the context-light slice worker while keeping workspace packages on
 * their built `lib` entries. This benchmark is a plan verifier, not a
 * `test:bench` case: `run-4k.sh` builds and runs it standalone.
 */
export default defineConfig({
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//],
    onlyBundle: false as const,
  },
  entry: { 'run-4k.worker': 'run-4k.worker.ts' },
  outDir: '../.dsh-build/context-light',
  clean: true,
  tsconfig: '../tsconfig.host.json',
})
