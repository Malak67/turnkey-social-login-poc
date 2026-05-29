import { useState } from "react";
import { useTurnkeySession } from "./useTurnkeySession";
import { WalletList } from "./WalletList";

export function LoginModal({ onClose }: { onClose: () => void }) {
  const tk = useTurnkeySession();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Sign in</h2>

        {tk.error && <div className="error">{tk.error}</div>}

        <button
          className="btn btn-primary"
          disabled={tk.busy}
          onClick={() => tk.signInWithGoogle()}
        >
          Continue with Google
        </button>

        <button
          className="btn"
          disabled={tk.busy}
          onClick={() => tk.signInWithX()}
        >
          Continue with X
        </button>

        <div className="divider">or with email</div>

        {!tk.pendingOtp ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void tk.signInWithEmail(email);
            }}
          >
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={tk.busy || !email}
              style={{ marginTop: "0.7rem", width: "100%" }}
            >
              Send code
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void tk.completeEmail(code);
            }}
          >
            <div className="field">
              <label htmlFor="code">Verification code</label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                required
              />
            </div>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={tk.busy || !code}
              style={{ marginTop: "0.7rem", width: "100%" }}
            >
              Verify
            </button>
            <p className="note" style={{ marginTop: "0.7rem" }}>
              Sent to <strong>{tk.pendingOtp.contact}</strong>. New email?
              Turnkey creates a sub-organization for you automatically via
              the Auth Proxy.
            </p>
          </form>
        )}

        <div className="divider">or connect an external wallet</div>
        <WalletList />
      </div>
    </div>
  );
}
