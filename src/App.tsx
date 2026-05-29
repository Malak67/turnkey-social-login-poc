import { useEffect, useState } from "react";
import { useConnection as useWagmiConnection } from "wagmi";
import { useTurnkeySession } from "./auth/useTurnkeySession";
import { useTurnkeyWagmiBridge } from "./auth/useTurnkeyWagmiBridge";
import { LoginModal } from "./auth/LoginModal";
import { AccountStatus } from "./auth/AccountStatus";
import "./App.css";

export default function App() {
  const [open, setOpen] = useState(false);
  // Bridge: pushes the Turnkey signer into our custom wagmi connector
  // on sign-in, and tears it down on sign-out. Result: `useConnection()`
  // becomes the single source of truth for "current address" — Turnkey
  // and external wallets surface uniformly through wagmi.
  useTurnkeyWagmiBridge();
  const tk = useTurnkeySession();
  const wagmi = useWagmiConnection();
  const isConnected = tk.isConnected || wagmi.isConnected;

  // Close the login modal as soon as any session terminates successfully
  // (Turnkey OR wagmi). The modal itself doesn't watch session state — it
  // just receives `onClose` — so we drive the close from here where both
  // hooks are visible.
  useEffect(() => {
    if (isConnected) setOpen(false);
  }, [isConnected]);

  return (
    <main className="page">
      <header className="hero">
        <h1>Turnkey + Rhinestone POC</h1>
        <p>
          Turnkey is the signer. wagmi is ours.
        </p>
      </header>

      {isConnected ? (
        <AccountStatus />
      ) : (
        <button className="cta" onClick={() => setOpen(true)}>
          Sign in
        </button>
      )}

      {open && <LoginModal onClose={() => setOpen(false)} />}
    </main>
  );
}
