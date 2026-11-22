import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/._*', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // Revert every vi.stubGlobal / vi.stubEnv before each test, so a stub can
    // never carry into the next test. tests/testHygiene.test.ts rejects plain
    // assignments, which these options cannot undo.
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
