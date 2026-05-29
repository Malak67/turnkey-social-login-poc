import { useEffect, useRef } from "react";
import { useConnect, useConnections, useDisconnect } from "wagmi";
import { setActiveTurnkeySigner } from "../turnkey-connector";
import { useTurnkeySession } from "./useTurnkeySession";

/**
 * Glue between the Turnkey session and the custom wagmi connector.
 *
 * When the Turnkey session produces a usable signer (an embedded
 * Ethereum account is materialised), we install it on the connector
 * and trigger `wagmi.connect({ connector: turnkey })`. From that
 * moment `useConnection()` everywhere in the app reads the Turnkey
 * address — the rest of the app no longer needs `useTurnkey()` for
 * "what is the current address."
 *
 * When Turnkey logs out (or the signer disappears for any reason),
 * we mirror that by calling `disconnectAsync` and clearing the
 * connector's stored signer.
 */
export function useTurnkeyWagmiBridge() {
  const tk = useTurnkeySession();
  const connections = useConnections();
  const { connectors, mutateAsync: connectAsync } = useConnect();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const turnkeyConnector = connectors.find((c) => c.id === "turnkey");
  const lastAttemptedAddress = useRef<string | null>(null);

  // Bind: when the Turnkey session is live, install the signer on the
  // connector and wagmi-connect to it.
  //
  // Two states this hook handles:
  //
  //   a) Session exists AND there's already an embedded Ethereum
  //      wallet account on the sub-org → install signer, connect.
  //   b) Session exists but the sub-org has NO embedded Ethereum
  //      wallet yet. This happens when the Auth Proxy's sub-org
  //      template isn't configured to create one at signup, or when
  //      the sub-org was created via wallet-stamper (external wallet
  //      attached) so it only has a connected wallet. We auto-create
  //      a default Ethereum wallet here, then proceed.
  //
  // The auto-create makes the Turnkey UX match Para's: the user
  // signs in via social auth and is *always* signed in with a wallet
  // address ready, with no extra "create wallet" click. The proper
  // production answer is to fix the dashboard sub-org template;
  // this is the belt-and-braces fallback.
  //
  // We attempt connect at most once per address change. `tk.address`
  // updates after `createDefaultWallet` runs (which refreshWallets()s).
  useEffect(() => {
    if (!turnkeyConnector) return;
    if (!tk.isConnected) return;
    if (tk.busy) return;

    const alreadyConnected = connections.some(
      (c) => c.connector.id === "turnkey",
    );

    let cancelled = false;
    (async () => {
      try {
        // (b) — session is live but no embedded ETH wallet yet.
        // Create one and let the next render iteration handle the
        // wagmi connect.
        if (!tk.address) {
          if (lastAttemptedAddress.current === "creating") return;
          lastAttemptedAddress.current = "creating";
          await tk.createDefaultWallet();
          return;
        }
        // (a) — session + embedded wallet ready.
        if (alreadyConnected) {
          lastAttemptedAddress.current = tk.address;
          return;
        }
        if (lastAttemptedAddress.current === tk.address) return;
        const signer = await tk.getSigner();
        if (cancelled) return;
        setActiveTurnkeySigner(signer);
        await connectAsync({ connector: turnkeyConnector });
        lastAttemptedAddress.current = tk.address;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[turnkey-wagmi] bridge step failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tk, connections, connectAsync, turnkeyConnector]);

  // Mirror logout. When the Turnkey session goes away but wagmi
  // still has the turnkey connector live, tear that down too.
  useEffect(() => {
    const turnkeyConn = connections.find((c) => c.connector.id === "turnkey");
    if (!turnkeyConn) return;
    if (tk.isConnected) return;

    setActiveTurnkeySigner(null);
    lastAttemptedAddress.current = null;
    void disconnectAsync({ connector: turnkeyConn.connector });
  }, [connections, disconnectAsync, tk.isConnected]);
}
