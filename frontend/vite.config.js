import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    proxy: {
      // Proxy API requests to the backend server
      '/api': {
        target: 'http://backend:3000',
        changeOrigin: true
      }
    }
  }
});