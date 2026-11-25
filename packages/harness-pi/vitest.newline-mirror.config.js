import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The published utils entry re-exports this module. Point at the source
      // so this test can run without a workspace build.
      '@ai-sdk/harness/utils': path.resolve(
        '../harness/src/utils/shell-quote.ts',
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/pi-workspace-mirror-newline.test.ts'],
  },
});
