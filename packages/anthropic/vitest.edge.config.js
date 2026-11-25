import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

const version = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version;

// https://vitejs.dev/config/
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // Node HTTP server tests cannot run in edge-runtime.
    exclude: [...configDefaults.exclude, '**/*.node.test.ts'],
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(version),
  },
});
