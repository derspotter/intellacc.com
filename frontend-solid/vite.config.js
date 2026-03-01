import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';

const proxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://backend:3000';
const serverPort = Number(process.env.VITE_SERVER_PORT || process.env.PORT || 5174);
const hmrPort = Number(process.env.VITE_HMR_CLIENT_PORT || process.env.PORT || process.env.VITE_SERVER_PORT || 4174);

export default defineConfig({
  plugins: [
    solid(),
    wasm(),
    topLevelAwait()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@openmls': path.resolve(__dirname, '../frontend/openmls-pkg'),
      '@shared': path.resolve(__dirname, '../shared'),
      '@app-services': path.resolve(__dirname, './src/services'),
      '@app-vault-service': path.resolve(__dirname, './src/services/mls/vaultService.js'),
      '@app-messaging-store': path.resolve(__dirname, './src/store/messagingStore.js')
    }
  },
  server: {
    port: serverPort,
    strictPort: true,
    host: '0.0.0.0', // Needed for Docker
    fs: {
      allow: [path.resolve(__dirname, '..')]
    },
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
      clientPort: hmrPort
    }
  },
  preview: {
    host: '0.0.0.0',
    port: serverPort,
    strictPort: true,
    allowedHosts: [
      'intellacc.de',
      'www.intellacc.de',
      'intellacc.com',
      'www.intellacc.com',
      'localhost',
      '127.0.0.1'
    ]
  }
});
