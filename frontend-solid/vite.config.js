import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const defaultApiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    proxy: {
      '/api': {
        target: defaultApiProxyTarget,
        changeOrigin: true,
        secure: false
      }
    }
  }
});
