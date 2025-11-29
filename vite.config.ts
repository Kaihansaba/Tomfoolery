import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { webcrypto } from 'crypto';

// Ensure Vite has WebCrypto when running under Node environments that lack it
if (
  typeof globalThis.crypto === 'undefined' ||
  typeof globalThis.crypto.getRandomValues !== 'function'
) {
  (globalThis as any).crypto = webcrypto as any;
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ['tomfoolery-1jyk.onrender.com'],
  },
  preview: {
    host: true,
    allowedHosts: ['tomfoolery-1jyk.onrender.com'],
    port: process.env.PORT ? Number(process.env.PORT) : 4173,
  },
});
