import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://intellacc_backend:3000',  // Updated to use container_name instead of service name
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
      }
    }
  }
  // esbuild configuration removed
});