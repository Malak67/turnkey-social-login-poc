import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useConfig } from "wagmi";
import { TurnkeyProvider } from "@turnkey/react-wallet-kit";
import { wagmiConfig } from "./wagmi";
import "./App.css";

const queryClient = new QueryClient();

const turnkeyOrgId = import.meta.env.VITE_TURNKEY_ORGANIZATION_ID ?? "";
const turnkeyAuthProxyConfigId =
  import.meta.env.VITE_TURNKEY_AUTH_PROXY_CONFIG_ID ?? "";

/**
 * Provider tree:
 *
 *   QueryClientProvider
 *     └─ WagmiProvider              ← our standalone wagmi config (src/wagmi.ts)
 *          └─ TurnkeyProvider       ← headless: Auth Proxy mode, no modal driven
 *               └─ WagmiBootAssertion
 *                    └─ App
 *
 * Hard requirement #1: TurnkeyProvider does NOT bring a wagmi provider of
 * its own (verified — `@turnkey/react-wallet-kit@2.0.0` has zero wagmi
 * imports across the package). The runtime assertion below is the
 * tripwire if that ever changes.
 */
export function Providers({ children }: { children: ReactNode }) {
  if (!turnkeyOrgId || !turnkeyAuthProxyConfigId) {
    return <MissingKeysNotice />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <TurnkeyProvider
          config={{
            organizationId: turnkeyOrgId,
            authProxyConfigId: turnkeyAuthProxyConfigId,
            // Where Google sends the user back after the OAuth popup. The
            // SDK lands on this URL inside the popup, parses the token
            // from the URL fragment, posts it back to the opener via
            // postMessage, and closes itself. Using the app's own origin
            // means the popup re-mounts our app — the SDK's in-popup code
            // detects it and handles the handoff.
            //
            // This URI must also be authorized in BOTH:
            //   - Google Cloud Console → OAuth client → Authorized redirect URIs
            //   - Turnkey dashboard → Wallet Kit → Socials → Google config
            auth: {
              oauthConfig: {
                oauthRedirectUri:
                  typeof window !== "undefined"
                    ? window.location.origin
                    : "",
              },
            },
            // Headless mode: we drive every flow through useTurnkey()
            // and never call handleLogin(). The provider still mounts
            // (it bootstraps the session/iframe stamper) but no modal
            // is rendered until we open one ourselves.
            ui: { renderModalInProvider: false },
          }}
        >
          <WagmiBootAssertion>{children}</WagmiBootAssertion>
        </TurnkeyProvider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}

/**
 * Hard requirement #1, enforced at runtime.
 *
 * `useConfig()` must return the exact `wagmiConfig` instance we export from
 * `src/wagmi.ts`. If a future vendor SDK update mounts its own
 * `WagmiProvider` between ours and the app — the Para POC's Risk 1 — that
 * shadow provider would have a different `config` reference and this
 * check throws at boot, before any user data goes through the wrong
 * config.
 */
function WagmiBootAssertion({ children }: { children: ReactNode }) {
  const observed = useConfig();
  if (observed !== wagmiConfig) {
    throw new Error(
      "[turnkey-poc] useConfig() did not return src/wagmi.ts → wagmiConfig. " +
        "A vendor package is shadowing our WagmiProvider. " +
        "Check `npm run audit:wagmi-providers` output and inspect node_modules/@turnkey/* " +
        "and node_modules/@rhinestone/* for new WagmiProvider imports. " +
        "See README.md → 'Hard requirement 1' for the rationale.",
    );
  }
  return <>{children}</>;
}

function MissingKeysNotice() {
  return (
    <div className="page">
      <div className="account-card" style={{ maxWidth: 540 }}>
        <h3>Set your Turnkey environment variables</h3>
        <p style={{ color: "#6b7280" }}>
          Copy <code>.env.example</code> to <code>.env</code> and fill in:
        </p>
        <pre
          style={{
            background: "#f1f1f3",
            padding: "0.9rem",
            borderRadius: 12,
            overflowX: "auto",
          }}
        >
          {`VITE_TURNKEY_ORGANIZATION_ID=...
VITE_TURNKEY_AUTH_PROXY_CONFIG_ID=...
VITE_TURNKEY_GOOGLE_CLIENT_ID=...`}
        </pre>
        <p style={{ color: "#6b7280" }}>
          Create a parent organization at{" "}
          <a href="https://app.turnkey.com" target="_blank" rel="noreferrer">
            app.turnkey.com
          </a>{" "}
          and enable Auth Proxy in the dashboard (Authentication → Auth
          Proxy). The proxy holds your parent API key so this POC stays
          backend-free.
        </p>
      </div>
    </div>
  );
}
