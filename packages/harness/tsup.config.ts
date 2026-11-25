import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Built together so shared modules (error classes in particular) land in
    // common chunks and keep a single identity across these entry points.
    entry: {
      index: 'src/index.ts',
      'agent/index': 'agent/index.ts',
      'utils/index': 'utils/index.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
  {
    // The bridge core runs inside the sandbox and is re-bundled into each
    // adapter's `bridge.mjs`. `ws` is resolved from the sandbox-installed
    // node_modules, never bundled here.
    entry: { 'bridge/index': 'bridge/index.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'node',
    dts: true,
    sourcemap: true,
    external: ['ws'],
  },
]);
