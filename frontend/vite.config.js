import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    cors: true,
    // Fix HMR in Docker - improved configuration
    hmr: {
      clientPort: 5173,
      port: 5173,
      host: 'localhost',
      protocol: 'ws'
    },
    // Better file watching for Docker volumes
    watch: {
      usePolling: true,
      interval: 1000
    },
    // Simplified proxy config
    proxy: {
      '/api': {
        target: 'http://backend:3000',
        changeOrigin: true,
        secure: false,
        ws: true
      }
    }
  }
});