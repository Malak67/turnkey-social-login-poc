import { Core } from "@walletconnect/core";
import { WalletKit, type IWalletKit, type WalletKitTypes } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import type { Address, Hex, LocalAccount, TypedDataDefinition } from "viem";
import {
  createPublicClient,
  createWalletClient,
  hexToBytes,
  http,
} from "viem";
import { mainnet, sepolia } from "viem/chains";

/**
 * Outbound WalletConnect bridge — turns this app into a real
 * WalletConnect wallet that any third-party dApp (Uniswap, OpenSea,
 * Reown's sample dApp, etc.) can connect to.
 *
 * Flow:
 *   1. dApp generates a `wc:` pairing URI and shows it as a QR code.
 *   2. User pastes the URI into our app.
 *   3. `pair(uri)` calls `walletKit.pair({ uri })` which contacts the
 *      relay and waits for a `session_proposal` event.
 *   4. We auto-approve the proposal with our Turnkey address on the
 *      chains we support.
 *   5. The dApp now has an active WC session and starts sending
 *      `session_request` events (`personal_sign`, `eth_signTypedData_v4`,
 *      `eth_sendTransaction`, etc.).
 *   6. We route each request to the Turnkey-backed viem `LocalAccount`
 *      and respond with the result.
 *
 * The signer is a parameter, not a module-level singleton — the bridge
 * is rebuilt whenever the active Turnkey signer changes (sign-in /
 * sign-out / passkey re-auth).
 */

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

const SUPPORTED_CHAINS = [mainnet, sepolia] as const;

export type WalletConnectSessionInfo = {
  topic: string;
  peerName: string;
  peerUrl: string;
  peerIcon: string | undefined;
  expiry: number;
};

export type PendingRequest = {
  id: number;
  topic: string;
  chainId: number;
  method: string;
  params: unknown[];
  peerName: string;
  /** Resolve/reject the request once the user decides. */
  resolve: (result: unknown) => void;
  reject: (reason: { code: number; message: string }) => void;
};

let kit: IWalletKit | null = null;
let activeSigner: LocalAccount | null = null;
let initPromise: Promise<IWalletKit> | null = null;

const sessionListeners = new Set<(sessions: WalletConnectSessionInfo[]) => void>();
const requestListeners = new Set<(req: PendingRequest) => void>();

export function setActiveWalletConnectSigner(signer: LocalAccount | null) {
  activeSigner = signer;
}

export function onSessionsChanged(
  fn: (sessions: WalletConnectSessionInfo[]) => void,
) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

export function onIncomingRequest(fn: (req: PendingRequest) => void) {
  requestListeners.add(fn);
  return () => requestListeners.delete(fn);
}

async function getKit(): Promise<IWalletKit> {
  if (!projectId) {
    throw new Error(
      "VITE_WALLETCONNECT_PROJECT_ID is not set — get one from cloud.reown.com",
    );
  }
  if (kit) return kit;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const core = new Core({ projectId });
    const k = await WalletKit.init({
      core,
      metadata: {
        name: "Turnkey POC Wallet",
        description:
          "Turnkey-backed embedded wallet, reachable from any dApp via WalletConnect",
        url: window.location.origin,
        icons: [],
      },
    });
    bindEvents(k);
    kit = k;
    return k;
  })();
  return initPromise;
}

/**
 * Public: paste a `wc:` URI from a dApp and broker the resulting
 * session. The session is auto-approved with the current Turnkey
 * address on both supported chains. session_proposal handling lives
 * in `bindEvents`.
 */
export async function pair(uri: string): Promise<void> {
  if (!activeSigner) {
    throw new Error(
      "No Turnkey signer is active. Sign in via Google / email / passkey first.",
    );
  }
  const k = await getKit();
  await k.pair({ uri });
}

export async function disconnect(topic: string): Promise<void> {
  const k = await getKit();
  await k.disconnectSession({
    topic,
    reason: getSdkError("USER_DISCONNECTED"),
  });
  emitSessions();
}

export async function disconnectAll(): Promise<void> {
  const k = await getKit();
  const sessions = k.getActiveSessions();
  await Promise.all(
    Object.values(sessions).map((s) =>
      k.disconnectSession({
        topic: s.topic,
        reason: getSdkError("USER_DISCONNECTED"),
      }),
    ),
  );
  emitSessions();
}

export async function listSessions(): Promise<WalletConnectSessionInfo[]> {
  const k = await getKit();
  return Object.values(k.getActiveSessions()).map(serializeSession);
}

/**
 * Internal: wire up event listeners on the WalletKit instance.
 * Auto-approves proposals; converts requests into PendingRequest
 * objects published to subscribers (the React hook decides whether
 * to auto-approve or prompt the user).
 */
function bindEvents(k: IWalletKit) {
  k.on("session_proposal", (proposal) => {
    void handleProposal(k, proposal);
  });
  k.on("session_request", (event) => {
    void handleRequest(k, event);
  });
  k.on("session_delete", () => {
    emitSessions();
  });
}

async function handleProposal(
  k: IWalletKit,
  proposal: WalletKitTypes.SessionProposal,
) {
  if (!activeSigner) {
    await k.rejectSession({
      id: proposal.id,
      reason: getSdkError("USER_REJECTED"),
    });
    return;
  }
  try {
    const accounts = SUPPORTED_CHAINS.map(
      (c) => `eip155:${c.id}:${activeSigner!.address}`,
    );
    const namespaces = buildApprovedNamespaces({
      proposal: proposal.params,
      supportedNamespaces: {
        eip155: {
          chains: SUPPORTED_CHAINS.map((c) => `eip155:${c.id}`),
          methods: [
            "personal_sign",
            "eth_sign",
            "eth_signTypedData",
            "eth_signTypedData_v4",
            "eth_sendTransaction",
            "eth_signTransaction",
          ],
          events: ["accountsChanged", "chainChanged"],
          accounts,
        },
      },
    });
    await k.approveSession({ id: proposal.id, namespaces });
  } catch (err) {
    await k.rejectSession({
      id: proposal.id,
      reason: {
        code: 5000,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
  emitSessions();
}

async function handleRequest(
  k: IWalletKit,
  event: WalletKitTypes.SessionRequest,
) {
  const { topic, params, id } = event;
  const { request, chainId } = params;
  const chainNumber = parseInt(chainId.split(":")[1] ?? "0", 10);

  const session = k.getActiveSessions()[topic];
  const peerName = session?.peer?.metadata?.name ?? "(unknown dApp)";

  // For the POC, every method is auto-approved. In a production
  // wallet this is where you'd raise a UI prompt and only proceed
  // on user consent. We still publish a PendingRequest so the UI
  // can log what happened.
  const pending: PendingRequest = {
    id,
    topic,
    chainId: chainNumber,
    method: request.method,
    params: request.params as unknown[],
    peerName,
    resolve: () => {
      /* set below */
    },
    reject: () => {
      /* set below */
    },
  };

  try {
    const result = await dispatchRpc(
      request.method,
      request.params as unknown[],
      chainNumber,
    );
    await k.respondSessionRequest({
      topic,
      response: { id, jsonrpc: "2.0", result },
    });
    pending.resolve(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await k.respondSessionRequest({
      topic,
      response: {
        id,
        jsonrpc: "2.0",
        error: { code: 5000, message },
      },
    });
    pending.reject({ code: 5000, message });
  }

  for (const fn of requestListeners) fn(pending);
}

async function dispatchRpc(
  method: string,
  params: unknown[],
  chainId: number,
): Promise<unknown> {
  const signer = activeSigner;
  if (!signer) throw new Error("No signer available");

  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  if (!chain) throw new Error(`Unsupported chain ${chainId}`);

  switch (method) {
    case "personal_sign": {
      const [hex] = params as [Hex, Address];
      return signer.signMessage({ message: { raw: hexToBytes(hex) } });
    }
    case "eth_sign": {
      const [, hex] = params as [Address, Hex];
      return signer.signMessage({ message: { raw: hexToBytes(hex) } });
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
      const walletClient = createWalletClient({
        chain,
        transport: http(),
        account: signer,
      });
      return walletClient.sendTransaction({
        to: tx.to,
        value: tx.value ? BigInt(tx.value) : undefined,
        data: tx.data,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      });
    }
    case "eth_signTransaction": {
      const [tx] = params as [
        {
          to: Address;
          value?: Hex;
          data?: Hex;
          gas?: Hex;
          nonce?: Hex;
        },
      ];
      // Sign but don't broadcast — used by some dApps to pre-sign
      // and submit themselves. We fill nonce/gas from the public
      // client so the signature is valid.
      const publicClient = createPublicClient({
        chain,
        transport: http(),
      });
      const nonce =
        tx.nonce !== undefined
          ? parseInt(tx.nonce, 16)
          : await publicClient.getTransactionCount({ address: signer.address });
      return signer.signTransaction({
        to: tx.to,
        value: tx.value ? BigInt(tx.value) : undefined,
        data: tx.data,
        gas: tx.gas ? BigInt(tx.gas) : 21000n,
        nonce,
        chainId: chain.id,
      } as Parameters<typeof signer.signTransaction>[0]);
    }
    default:
      throw new Error(`Unsupported RPC method: ${method}`);
  }
}

function serializeSession(
  s: ReturnType<IWalletKit["getActiveSessions"]>[string],
): WalletConnectSessionInfo {
  return {
    topic: s.topic,
    peerName: s.peer?.metadata?.name ?? "(unknown)",
    peerUrl: s.peer?.metadata?.url ?? "",
    peerIcon: s.peer?.metadata?.icons?.[0],
    expiry: s.expiry,
  };
}

function emitSessions() {
  if (!kit) return;
  const list = Object.values(kit.getActiveSessions()).map(serializeSession);
  for (const fn of sessionListeners) fn(list);
}
