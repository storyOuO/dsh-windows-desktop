import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['electron/**/*.ts', 'src/**/*.ts'],
      exclude: ['electron/preload.ts'],
      reporter: ['text', 'lcov', 'html'],
    },
  },
})
