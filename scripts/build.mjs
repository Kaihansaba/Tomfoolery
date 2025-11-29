import { randomFillSync, webcrypto } from 'crypto';

// Provide a WebCrypto-compatible surface for Vite when Node does not expose one
if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto = webcrypto ?? {
    getRandomValues(arr) {
      if (arr == null) return arr;
      randomFillSync(arr);
      return arr;
    },
  };
}

const { build } = await import('vite');
await build();
