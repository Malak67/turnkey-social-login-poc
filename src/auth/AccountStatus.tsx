import { useState } from "react";
import {
  useConnection as useWagmiConnection,
  useDisconnect,
  useSignMessage,
} from "wagmi";
import { useTurnkeySession } from "./useTurnkeySession";
import { WalletConnectPanel } from "../walletconnect/WalletConnectPanel";

export function AccountStatus() {
  const tk = useTurnkeySession();
  // After the Turnkey-wagmi bridge runs (see useTurnkeyWagmiBridge),
  // `useConnection()` returns the Turnkey address as well — so the
  // whole app can read the active address through this one hook
  // regardless of whether the user signed in via Turnkey, MetaMask,
  // or WalletConnect.
  const wagmi = useWagmiConnection();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const { mutateAsync: signMessageAsync, isPending: wagmiSigning } =
    useSignMessage();
  const [signedMessage, setSignedMessage] = useState<string | null>(null);
  const [signedBy, setSignedBy] = useState<"turnkey" | "wallet" | null>(null);
  const [signing, setSigning] = useState(false);
  const [signingError, setSigningError] = useState<string | null>(null);

  const handleSignOut = async () => {
    await Promise.allSettled([tk.logout(), disconnectAsync()]);
    setSignedMessage(null);
    setSignedBy(null);
    setSigningError(null);
  };

  /**
   * Turnkey signer round-trip. Lifts the EIP-191 message through the
   * viem `LocalAccount` returned by `@turnkey/viem`. This is the
   * verification of hard requirement #2.
   */
  const handleSignTurnkey = async () => {
    setSigning(true);
    setSigningError(null);
    try {
      const signer = await tk.getSigner();
      const signature = await signer.signMessage({
        message: "hello from turnkey-poc",
      });
      setSignedMessage(signature);
      setSignedBy("turnkey");
    } catch (e) {
      setSigningError(formatError(e));
    } finally {
      setSigning(false);
    }
  };

  /**
   * Parallel wagmi signer round-trip. Used when the user logged in
   * via MetaMask / Coinbase / WalletConnect — Turnkey has no session
   * then, so we route through whichever wagmi connector is active.
   */
  const handleSignWagmi = async () => {
    setSigningError(null);
    try {
      const signature = await signMessageAsync({
        message: "hello from turnkey-poc",
      });
      setSignedMessage(signature);
      setSignedBy("wallet");
    } catch (e) {
      setSigningError(formatError(e));
    }
  };

  return (
    <div className="account-card">
      <div className="row">
        <span className="label">Active address (wagmi)</span>
        <span className="value">{wagmi.address ?? "—"}</span>
      </div>
      <div className="row">
        <span className="label">Source</span>
        <span className="value">
          {wagmi.connector?.id === "turnkey"
            ? "Turnkey"
            : (wagmi.connector?.name ?? "—")}
        </span>
      </div>
      <div className="row">
        <span className="label">Turnkey raw signer</span>
        <span className="value">{tk.address ?? "—"}</span>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid #eee" }} />

      <button
        className="btn btn-primary"
        disabled={signing || !tk.isConnected}
        onClick={handleSignTurnkey}
        title={
          tk.isConnected
            ? undefined
            : "Sign in with Google / email / passkey first"
        }
      >
        Sign "hello from turnkey-poc" (Turnkey)
      </button>

      <button
        className="btn"
        disabled={wagmiSigning || !wagmi.isConnected}
        onClick={handleSignWagmi}
        title={
          wagmi.isConnected
            ? undefined
            : "Connect an external wallet first"
        }
      >
        Sign "hello from turnkey-poc" (external wallet)
      </button>

      {signedMessage && (
        <p className="note" style={{ wordBreak: "break-all" }}>
          <strong>Signature ({signedBy}):</strong> {signedMessage}
        </p>
      )}

      {/*
        Fallback button only — the bridge in useTurnkeyWagmiBridge
        auto-creates the wallet on sign-in, so this should never
        appear in the happy path. It's kept as a manual escape if
        the auto-create errors (network glitch, dashboard policy
        change, etc.).
      */}
      {tk.isConnected && !tk.address && !tk.busy && (
        <button
          className="btn"
          disabled={tk.busy}
          onClick={() => tk.createDefaultWallet()}
        >
          Retry creating an embedded Ethereum wallet
        </button>
      )}

      <button
        className="btn"
        disabled={tk.busy || !tk.isConnected}
        onClick={() => tk.attachPasskeyToWallet()}
        title={
          tk.isConnected
            ? undefined
            : "Only applies to the Turnkey wallet — sign in with Google / email first"
        }
      >
        Add a passkey to this Turnkey wallet
      </button>

      {(tk.error || signingError) && (
        <div className="error">{tk.error ?? signingError}</div>
      )}

      <hr style={{ border: "none", borderTop: "1px solid #eee" }} />

      {/* The wallet's outbound role: expose itself via WalletConnect so any
          third-party dApp can sign through the Turnkey signer. */}
      <WalletConnectPanel />

      <hr style={{ border: "none", borderTop: "1px solid #eee" }} />
      <button className="btn" onClick={handleSignOut}>
        Sign out
      </button>
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
