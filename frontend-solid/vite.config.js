import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';

const proxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://backend:3000';

export default defineConfig({
  plugins: [
    solid(),
    wasm(),
    topLevelAwait()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@openmls': path.resolve(__dirname, './src/pkg/openmls-wasm')
    }
  },
  server: {
    port: 5174,
    strictPort: true,
    host: '0.0.0.0', // Needed for Docker
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true
      },
      '/socket.io': {
        target: proxyTarget,
        ws: true
      }
    },
    watch: {
      usePolling: true
    },
    hmr: {
      clientPort: 5174
    }
  }
});
