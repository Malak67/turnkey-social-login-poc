/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TURNKEY_ORGANIZATION_ID?: string;
  readonly VITE_TURNKEY_AUTH_PROXY_CONFIG_ID?: string;
  readonly VITE_TURNKEY_GOOGLE_CLIENT_ID?: string;
  readonly VITE_TURNKEY_X_CLIENT_ID?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
