import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@openmls': path.resolve(__dirname, './openmls-pkg'),
      '@shared': path.resolve(__dirname, '../shared'),
      '@app-services': path.resolve(__dirname, './src/services'),
      '@app-vault-service': path.resolve(__dirname, './src/services/vaultService.js'),
      '@app-messaging-store': path.resolve(__dirname, './src/stores/messagingStore.js')
    }
  },
  test: {
    environment: 'jsdom',
  },
});
