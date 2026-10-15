import { defineConfig } from 'vite';

// In-browser vault + trading engine served by the board (server/web/vendor).
export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'server/web/vendor',
    emptyOutDir: false,
    codeSplitting: false,
    minify: true,
    lib: { entry: 'src/webEngine.ts', name: 'TrenchEngineBundle', formats: ['iife'], fileName: () => 'engine.js' },
  },
});
