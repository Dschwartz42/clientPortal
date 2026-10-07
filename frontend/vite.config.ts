/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
    // Pin west of UTC so date-only parsing regressions (new Date('2026-03-01')) fail locally and in CI.
    env: { TZ: 'America/Los_Angeles' },
  },
})
