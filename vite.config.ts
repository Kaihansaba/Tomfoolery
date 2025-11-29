import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { webcrypto } from 'crypto';

// Ensure Vite has WebCrypto when running under Node environments that lack it
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
  (globalThis as any).crypto = webcrypto as any;
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
});
