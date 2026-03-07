import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import viteCompression from 'vite-plugin-compression';
import path from 'path';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const proxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://backend:3000';
const serverPort = Number(process.env.VITE_SERVER_PORT || process.env.PORT || 5174);
const hmrPort = Number(process.env.VITE_HMR_CLIENT_PORT || process.env.PORT || process.env.VITE_SERVER_PORT || 4174);
const allowedHosts = [
  'intellacc.de',
  'www.intellacc.de',
  'intellacc.com',
  'www.intellacc.com',
  'localhost',
  '127.0.0.1'
];

export default defineConfig({
  plugins: [
    solid(),
    wasm(),
    topLevelAwait(),
    viteCompression({
      algorithm: 'brotliCompress',
      ext: '.br',
      threshold: 1024,
      filter: /\.(js|css|html|wasm)$/i,
    }),
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 1024,
      filter: /\.(js|css|html|wasm)$/i,
    }),
  ],
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()]
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@openmls': path.resolve(__dirname, '../shared/openmls-pkg'),
      '@shared': path.resolve(__dirname, '../shared'),
      '@app-services': path.resolve(__dirname, './src/services'),
      '@app-vault-service': path.resolve(__dirname, './src/services/mls/vaultService.js'),
      '@app-messaging-store': path.resolve(__dirname, './src/store/messagingStore.js')
    }
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'openmls-wasm': ['@openmls']
        }
      }
    }
  },
  server: {
    port: serverPort,
    strictPort: true,
    host: '0.0.0.0', // Needed for Docker
    allowedHosts,
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
    allowedHosts
  }
});
