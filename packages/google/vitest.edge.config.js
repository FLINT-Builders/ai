import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

const version = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version;

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __PACKAGE_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: 'edge-runtime',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // *.node.test.ts opens local sockets. The edge runtime cannot host them.
    exclude: [...configDefaults.exclude, '**/*.node.test.ts'],
  },
});
