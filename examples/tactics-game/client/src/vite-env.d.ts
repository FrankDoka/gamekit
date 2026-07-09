/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COLYSEUS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
