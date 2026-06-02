import { useState } from "react";
import { useWalletConnectBridge } from "./useWalletConnectBridge";

/**
 * UI for the outbound WalletConnect bridge.
 *
 * Three things visible:
 *   - "Paste a wc: URI" field with a Connect button
 *   - Active sessions list (which dApps are connected right now)
 *   - Recent requests log (what they asked for, what we did)
 */
export function WalletConnectPanel() {
  const wc = useWalletConnectBridge();
  const [uri, setUri] = useState("");

  const handlePair = async () => {
    if (!uri.trim()) return;
    await wc.pair(uri.trim());
    setUri("");
  };

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.85rem",
        marginTop: "0.5rem",
      }}
    >
      <div style={{ fontWeight: 600 }}>Wallet (outbound WalletConnect)</div>
      <p className="note">
        Paste a <code>wc:</code> URI from any third-party dApp. The session
        is auto-approved and the Turnkey signer handles every request.
      </p>

      <div className="field">
        <label htmlFor="wc-uri">wc: URI</label>
        <input
          id="wc-uri"
          type="text"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="wc:...@2?relay-protocol=...&symKey=..."
        />
      </div>

      <button
        className="btn btn-primary"
        disabled={wc.busy || !uri.trim()}
        onClick={() => void handlePair()}
      >
        {wc.busy ? "Connecting…" : "Connect to dApp"}
      </button>

      {wc.error && <div className="error">{wc.error}</div>}

      {wc.sessions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
            Active sessions ({wc.sessions.length})
          </div>
          {wc.sessions.map((s) => (
            <div
              key={s.topic}
              className="row"
              style={{
                background: "#f9fafb",
                padding: "0.5rem 0.7rem",
                borderRadius: 8,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {s.peerName}
                {s.peerUrl ? (
                  <span style={{ color: "#6b7280" }}> — {s.peerUrl}</span>
                ) : null}
              </span>
              <button
                className="btn"
                style={{
                  padding: "0.2rem 0.6rem",
                  fontSize: "0.8rem",
                }}
                onClick={() => void wc.disconnect(s.topic)}
                disabled={wc.busy}
              >
                Disconnect
              </button>
            </div>
          ))}
          <button
            className="btn"
            disabled={wc.busy}
            onClick={() => void wc.disconnectAll()}
            style={{ marginTop: "0.3rem" }}
          >
            Disconnect all
          </button>
        </div>
      )}

      {wc.recent.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
            Recent requests
          </div>
          {wc.recent.map((r) => (
            <div
              key={`${r.topic}-${r.id}`}
              className="note"
              style={{ fontSize: "0.8rem" }}
            >
              <strong>{r.peerName}</strong> ·{" "}
              <code>{r.method}</code> · chain {r.chainId}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
