import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import viteCompression from 'vite-plugin-compression';
import path from 'path';

const disableHmr =
  process.env.VITE_DISABLE_HMR === '1' ||
  process.env.VITE_DISABLE_HMR === 'true';
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://intellacc_backend:3000';

export default defineConfig({
  define: {
    'process.env': {},
    global: 'globalThis'
  },
  plugins: [
    wasm(),
    topLevelAwait(),
    // Brotli compression (best compression, slower)
    viteCompression({
      algorithm: 'brotliCompress',
      ext: '.br',
      threshold: 1024, // Only compress files > 1KB
      filter: /\.(js|css|html|wasm)$/i,
    }),
    // Gzip fallback for older clients
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 1024,
      filter: /\.(js|css|html|wasm)$/i,
    }),
  ],
  resolve: {
    alias: {
      '@openmls': path.resolve(__dirname, './openmls-pkg'),
      '@shared': path.resolve(__dirname, '../shared'),
      '@app-services': path.resolve(__dirname, './src/services'),
      '@app-vault-service': path.resolve(__dirname, './src/services/vaultService.js'),
      '@app-messaging-store': path.resolve(__dirname, './src/stores/messagingStore.js')
    }
  },
  assetsInclude: ['**/*.wasm'],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      allow: [path.resolve(__dirname, '..')]
    },
    hmr: disableHmr ? false : undefined,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
        proxyTimeout: 30000, // Increased timeout to 30s for slower connections
        timeout: 30000,      // Connection timeout
        ws: true,            // Support WebSocket
        xfwd: true,          // Add x-forwarded headers
        
        // More verbose proxy configuration
        configure: (proxy, options) => {
          // Increase max headers (if needed)
          proxy.options.maxHeadersCount = 200;
          
          // Log all proxy errors in detail
          proxy.on('error', (err, req, res) => {
            console.error('DETAILED PROXY ERROR:', err);
            console.error('Request URL that caused error:', req.url);
            
            // Try to send error to client if headers not sent
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                error: 'Proxy Error', 
                message: err.message,
                code: err.code || 'UNKNOWN'
              }));
            }
          });
          
          // Set up proxy debugging
          proxy.on('proxyReq', (proxyReq, req, res) => {
            console.log(`PROXY REQ: ${req.method} ${req.url}`);
            // Log headers to debug authentication issues
            console.log('Request Headers:', req.headers);
          });
          
          proxy.on('proxyRes', (proxyRes, req, res) => {
            console.log(`PROXY RES: ${proxyRes.statusCode} for ${req.method} ${req.url}`);
            
            // For 4xx/5xx responses - log more details
            if (proxyRes.statusCode >= 400) {
              let body = '';
              proxyRes.on('data', chunk => { 
                body += chunk.toString(); 
              });
              
              proxyRes.on('end', () => {
                console.log(`Error response body for ${req.url}:`, body);
              });
            }
          });
        }
      },
      '/socket.io': {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
        secure: false
      }
    }
  }
  ,
  optimizeDeps: {
    exclude: []
  }
  // esbuild configuration removed
});
