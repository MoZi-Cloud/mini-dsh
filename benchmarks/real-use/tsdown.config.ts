import { defineConfig } from 'tsdown'

/**
 * Compile the real-use lane worker while keeping workspace packages on their
 * built `lib` entries. Like the context-light slice, this lane is a plan
 * verifier, not a `test:bench` case: `run-real-use.sh` builds and runs it
 * standalone.
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
  entry: { 'run-real-use.worker': 'run-real-use.worker.ts' },
  outDir: '../.dsh-build/real-use',
  clean: true,
  tsconfig: '../tsconfig.host.json',
})
