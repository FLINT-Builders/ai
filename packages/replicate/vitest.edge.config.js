import { configDefaults, defineConfig } from 'vitest/config';
import packageJson from './package.json';

// https://vitejs.dev/config/
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // Node HTTP listeners are unavailable in the edge runtime.
    exclude: [...configDefaults.exclude, '**/*.node.test.ts'],
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(packageJson.version),
  },
});
