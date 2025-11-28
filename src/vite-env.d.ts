/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly [key: string]: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
