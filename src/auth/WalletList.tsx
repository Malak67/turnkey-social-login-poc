import { useState } from "react";
import { useConnect, useConnectors } from "wagmi";

/**
 * Wallet section, fed from OUR wagmi config (src/wagmi.ts) — not Turnkey's.
 * EIP-6963 connectors light up automatically for every installed extension;
 * WalletConnect appears as one extra row when a project id is set.
 *
 * Uses `mutateAsync` so connector errors (WalletConnect cloud rejected the
 * project id, popup blocked, user cancelled, etc.) actually surface
 * instead of being swallowed by the fire-and-forget `mutate`.
 */
export function WalletList() {
  // Hide the Turnkey connector from the manual wallet list — it's a
  // programmatic connector driven by useTurnkeyWagmiBridge after the
  // user signs in via Google / X / email. Clicking it directly would
  // try to connect with no signer and fail with
  // "Turnkey connector: no active signer."
  const connectors = useConnectors().filter((c) => c.id !== "turnkey");
  const { mutateAsync: connectAsync, isPending } = useConnect();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const handleConnect = async (connector: (typeof connectors)[number]) => {
    setError(null);
    setPendingId(connector.uid);
    try {
      await connectAsync({ connector });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setPendingId(null);
    }
  };

  if (connectors.length === 0) {
    return (
      <p className="note">
        No wallet connectors detected. Install MetaMask / Coinbase / etc.,
        or set <code>VITE_WALLETCONNECT_PROJECT_ID</code>.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {connectors.map((c) => (
        <button
          key={c.uid}
          className="btn"
          disabled={isPending}
          onClick={() => handleConnect(c)}
        >
          {pendingId === c.uid ? "Connecting…" : c.name}
          {c.type === "injected" ? "  ·  injected" : ""}
        </button>
      ))}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "Unknown error";
  }
}
