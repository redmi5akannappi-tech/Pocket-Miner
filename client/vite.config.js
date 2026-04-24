import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],

    // Dev server proxy — only applies when running `npm run dev`
    // In production the VITE_API_URL env var points directly to the backend
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/ws': {
          target: 'ws://localhost:3001',
          ws: true,
          changeOrigin: true,
        },
      },
    },

    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
            axios:  ['axios'],
          },
        },
      },
    },

    // Expose env vars to the client (only VITE_ prefixed ones are exposed by default)
    define: {
      __APP_VERSION__: JSON.stringify('1.0.0'),
    },
  };
});
