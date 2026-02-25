import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('PWA Manifest', () => {
    it('should be valid JSON', () => {
        const manifestPath = path.resolve(__dirname, '../public/manifest.json');
        const content = fs.readFileSync(manifestPath, 'utf8');
        expect(() => JSON.parse(content)).not.toThrow();
    });

    it('should contain required PWA fields', () => {
        const manifestPath = path.resolve(__dirname, '../public/manifest.json');
        const content = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(content);

        expect(manifest).toHaveProperty('name', 'Intellacc');
        expect(manifest).toHaveProperty('short_name', 'Intellacc');
        expect(manifest).toHaveProperty('display', 'standalone');
        expect(manifest).toHaveProperty('start_url', '/');
        expect(manifest).toHaveProperty('icons');
        expect(Array.isArray(manifest.icons)).toBe(true);
        expect(manifest.icons.length).toBeGreaterThan(0);
    });
});
