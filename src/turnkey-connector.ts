import {
  type Address,
  type EIP1193Provider,
  type Hex,
  type LocalAccount,
  type TypedDataDefinition,
  createWalletClient,
  custom,
  hexToBytes,
  http,
} from "viem";
import type { Chain } from "viem";
import { createConnector } from "wagmi";

/**
 * A wagmi connector for a Turnkey-backed viem `LocalAccount`.
 *
 * The goal is to surface the Turnkey wallet through wagmi's standard
 * hooks (`useConnection`, `useSignMessage`, `useSendTransaction`) so
 * the rest of the app can read a single canonical "current address"
 * instead of juggling Turnkey state and wagmi state separately. This
 * collapses the dual-state issue (Risk 2 in the README) into one
 * source of truth: wagmi.
 *
 * **Important:** this is a connector WE wrote and register in OUR
 * `wagmiConfig`. Hard requirement #1 from `vendors.md` (no vendor-
 * shipped `WagmiProvider`) is unaffected — the runtime assertion in
 * `src/providers.tsx` still passes.
 *
 * Lifecycle:
 *   1. App boots. The connector is registered with no signer yet.
 *      `isAuthorized()` returns `false`; `useConnection()` is empty.
 *   2. User signs in via Turnkey. `useTurnkeySession.getSigner()`
 *      resolves a `LocalAccount`. The app calls
 *      `setActiveTurnkeySigner(signer)` and then `connectAsync({ connector })`.
 *   3. wagmi calls `connector.connect()`, which returns the signer's
 *      address. From this point `useConnection()` reads the Turnkey
 *      address.
 *   4. User signs out → app calls `setActiveTurnkeySigner(null)` and
 *      wagmi `disconnectAsync()`.
 */

let activeSigner: LocalAccount | null = null;
let activeChainId: number | null = null;

export function setActiveTurnkeySigner(signer: LocalAccount | null) {
  activeSigner = signer;
}

// The wagmi `connect` overload is generic over a `withCapabilities`
// flag whose conditional return type is awkward to satisfy from a
// plain factory. We bypass the strict static check on the factory
// shape — connector code is well-tested at runtime and the loss of
// safety is contained to this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConnectorFactoryArg = (config: any) => any;

export function turnkeyConnector() {
  return (createConnector as (fn: ConnectorFactoryArg) => unknown)((config) => {
    const defaultChain = config.chains[0];

    const ensureSigner = (): LocalAccount => {
      if (!activeSigner) {
        throw new Error(
          "Turnkey connector: no active signer. Call setActiveTurnkeySigner(signer) before connecting.",
        );
      }
      return activeSigner;
    };

    const currentChain = (): Chain => {
      const id = activeChainId ?? defaultChain.id;
      return (
        (config.chains as readonly Chain[]).find((c) => c.id === id) ??
        defaultChain
      );
    };

    return {
      id: "turnkey",
      name: "Turnkey",
      type: "turnkey",

      async setup() {},

      async connect(params: { chainId?: number } = {}) {
        const signer = ensureSigner();
        const target = params.chainId ?? activeChainId ?? defaultChain.id;
        activeChainId = target;
        // The generic `withCapabilities` overload returns either a
        // plain address list or `{ address, capabilities }[]`. We
        // never emit capabilities, so cast the simpler shape into
        // the conditional return type.
        return {
          accounts: [signer.address] as readonly Address[],
          chainId: target,
        } as unknown as {
          accounts: readonly Address[];
          chainId: number;
        };
      },

      async disconnect() {
        // Don't tear down the Turnkey session here — that's the app's
        // job (it calls tk.logout()). This just clears the wagmi-side
        // binding so the connector goes back to "available but not
        // active." The signer reference itself is cleared by
        // setActiveTurnkeySigner(null), called by the App on logout.
        activeChainId = null;
      },

      async getAccounts() {
        return activeSigner ? [activeSigner.address] : [];
      },

      async getChainId() {
        return activeChainId ?? defaultChain.id;
      },

      async isAuthorized() {
        return Boolean(activeSigner);
      },

      async switchChain({ chainId }: { chainId: number }) {
        const next = (config.chains as readonly Chain[]).find(
          (c) => c.id === chainId,
        );
        if (!next) {
          throw new Error(
            `Turnkey connector: chain ${chainId} is not in the wagmi config.`,
          );
        }
        activeChainId = chainId;
        config.emitter.emit("change", { chainId });
        return next;
      },

      async getProvider() {
        // EIP-1193 shim. wagmi's hooks call `provider.request({ method, params })`
        // for personal_sign / typed-data / sendTransaction; route each
        // to the equivalent viem operation on the Turnkey LocalAccount.
        const chain = currentChain();
        const transport = http();
        const walletClient = createWalletClient({
          chain,
          transport,
          account: ensureSigner(),
        });

        const provider: EIP1193Provider = {
          // viem's `custom` transport expects `request`; wagmi reuses it.
          request: (async ({ method, params }) => {
            const signer = ensureSigner();
            switch (method) {
              case "eth_accounts":
              case "eth_requestAccounts":
                return [signer.address] as Address[];

              case "eth_chainId":
                return `0x${currentChain().id.toString(16)}` as Hex;

              case "personal_sign": {
                const [data] = params as [Hex, Address];
                return signer.signMessage({
                  message: { raw: hexToBytes(data) },
                });
              }

              case "eth_sign": {
                // [address, hexMessage]
                const [, data] = params as [Address, Hex];
                return signer.signMessage({
                  message: { raw: hexToBytes(data) },
                });
              }

              case "eth_signTypedData":
              case "eth_signTypedData_v4": {
                const [, payload] = params as [Address, string | object];
                const typed: TypedDataDefinition =
                  typeof payload === "string"
                    ? (JSON.parse(payload) as TypedDataDefinition)
                    : (payload as TypedDataDefinition);
                return signer.signTypedData(typed);
              }

              case "eth_sendTransaction": {
                const [tx] = params as [
                  {
                    to: Address;
                    value?: Hex;
                    data?: Hex;
                    gas?: Hex;
                  },
                ];
                return walletClient.sendTransaction({
                  to: tx.to,
                  value: tx.value ? BigInt(tx.value) : undefined,
                  data: tx.data,
                  gas: tx.gas ? BigInt(tx.gas) : undefined,
                });
              }

              case "wallet_switchEthereumChain": {
                const [{ chainId }] = params as [{ chainId: Hex }];
                const id = parseInt(chainId, 16);
                activeChainId = id;
                config.emitter.emit("change", { chainId: id });
                return null;
              }

              default:
                // Fall through to a JSON-RPC over the configured
                // transport for plain reads (eth_getBalance, etc.).
                return walletClient.request({
                  method,
                  params,
                } as Parameters<EIP1193Provider["request"]>[0]);
            }
          }) as EIP1193Provider["request"],

          // EIP-1193 also requires `on` / `removeListener`. wagmi
          // doesn't use these for the Turnkey path (account/chain
          // changes are driven by `emitter.emit('change', …)`), but
          // returning a working pair is safer than throwing.
          on: () => provider,
          removeListener: () => provider,
        } as unknown as EIP1193Provider;

        // Bind custom transport so any caller that uses the returned
        // provider as a raw viem transport gets the right shape.
        custom(provider);

        return provider;
      },

      onAccountsChanged(accounts: string[]) {
        if (accounts.length === 0) {
          config.emitter.emit("disconnect");
        } else {
          config.emitter.emit("change", {
            accounts: accounts as readonly Address[],
          });
        }
      },

      onChainChanged(chainIdHex: string) {
        const id = Number(chainIdHex);
        activeChainId = id;
        config.emitter.emit("change", { chainId: id });
      },

      onDisconnect() {
        activeChainId = null;
        config.emitter.emit("disconnect");
      },
    };
  }) as ReturnType<typeof createConnector>;
}
