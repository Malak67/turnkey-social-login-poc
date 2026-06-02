import { useCallback, useEffect, useRef, useState } from "react";
import { useTurnkeySession } from "../auth/useTurnkeySession";
import {
  disconnect as disconnectSession,
  disconnectAll,
  listSessions,
  onIncomingRequest,
  onSessionsChanged,
  pair,
  setActiveWalletConnectSigner,
  type PendingRequest,
  type WalletConnectSessionInfo,
} from "./wallet";

/**
 * React glue for the outbound WalletConnect bridge.
 *
 * Responsibilities:
 *   - Keep the bridge's "active signer" in sync with the Turnkey session.
 *     When the user signs in, we install the signer; on sign-out we clear
 *     it (any subsequent inbound dApp request is rejected).
 *   - Surface active sessions as React state so the UI can render the
 *     "connected to X dApp" list.
 *   - Surface a rolling log of incoming requests so the UI can show what
 *     the dApp asked for (signed message, sent tx, etc.).
 *   - Expose `pair(uri)`, `disconnect(topic)`, `disconnectAll()` for the UI.
 */
export function useWalletConnectBridge() {
  const tk = useTurnkeySession();
  const [sessions, setSessions] = useState<WalletConnectSessionInfo[]>([]);
  const [recent, setRecent] = useState<PendingRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSignerAddress = useRef<string | null>(null);

  // Push the Turnkey signer into the bridge whenever it materialises
  // or changes. When the session ends, we clear it so the bridge stops
  // signing for an absent user.
  useEffect(() => {
    if (!tk.isConnected || !tk.address) {
      setActiveWalletConnectSigner(null);
      lastSignerAddress.current = null;
      return;
    }
    if (lastSignerAddress.current === tk.address) return;
    let cancelled = false;
    (async () => {
      try {
        const signer = await tk.getSigner();
        if (cancelled) return;
        setActiveWalletConnectSigner(signer);
        lastSignerAddress.current = tk.address;
      } catch (e) {
        if (!cancelled) setError(formatError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tk]);

  // Subscribe to bridge state once.
  useEffect(() => {
    let mounted = true;
    void listSessions().then((list) => {
      if (mounted) setSessions(list);
    });
    const offSessions = onSessionsChanged((list) => {
      if (mounted) setSessions(list);
    });
    const offRequests = onIncomingRequest((req) => {
      if (!mounted) return;
      // keep the last 10 requests for the UI log
      setRecent((prev) => [req, ...prev].slice(0, 10));
    });
    return () => {
      mounted = false;
      offSessions();
      offRequests();
    };
  }, []);

  const handlePair = useCallback(async (uri: string) => {
    setBusy(true);
    setError(null);
    try {
      await pair(uri);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleDisconnect = useCallback(async (topic: string) => {
    setBusy(true);
    setError(null);
    try {
      await disconnectSession(topic);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleDisconnectAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnectAll();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    sessions,
    recent,
    busy,
    error,
    pair: handlePair,
    disconnect: handleDisconnect,
    disconnectAll: handleDisconnectAll,
  };
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
