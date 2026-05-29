import { createConfig, http } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { walletConnect } from "wagmi/connectors";
import { turnkeyConnector } from "./turnkey-connector";

const walletConnectProjectId =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

/**
 * Standalone wagmi config. Owns the inbound EOA connector list.
 *
 * Two flavours of connector:
 *   - External EOAs (MetaMask, Coinbase, WalletConnect) — surfaced
 *     via EIP-6963 discovery + an explicit `walletConnect` entry.
 *   - The Turnkey-backed embedded wallet — surfaced as a custom
 *     connector we wrote ourselves (src/turnkey-connector.ts). The
 *     connector is only "authorised" after a Turnkey session loads
 *     and the app calls `setActiveTurnkeySigner(signer)`. Until then
 *     `useConnection()` returns nothing.
 *
 * Hard requirement #1 still holds: this is OUR wagmi config, with a
 * connector WE wrote. No vendor ships its own `WagmiProvider`. The
 * boot-time assertion in `src/providers.tsx` continues to pass.
 */
export const wagmiConfig = createConfig({
  chains: [mainnet, sepolia],
  multiInjectedProviderDiscovery: true,
  connectors: [
    turnkeyConnector(),
    ...(walletConnectProjectId
      ? [
          walletConnect({
            projectId: walletConnectProjectId,
            showQrModal: true,
          }),
        ]
      : []),
  ],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
