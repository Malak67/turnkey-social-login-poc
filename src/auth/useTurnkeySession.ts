import { useCallback, useMemo, useState } from "react";
import { OtpType, useTurnkey } from "@turnkey/react-wallet-kit";
import { createAccountWithAddress } from "@turnkey/viem";
import type { LocalAccount } from "viem";

/**
 * Thin wrapper around `useTurnkey()` that exposes the headless flows we
 * actually use here:
 *
 *   - signInWithEmail(email)         → triggers OTP, returns an otpId
 *   - completeEmail(code)            → verifies OTP, creates sub-org if new
 *   - signInWithGoogle()             → handleGoogleOauth (popup)
 *   - signInWithPasskey()            → loginWithPasskey
 *   - attachPasskeyToWallet()        → addPasskey to the current session
 *   - getSigner()                    → viem LocalAccount over the Turnkey wallet
 *
 * Nothing here touches wagmi. Turnkey produces a viem `LocalAccount` and
 * stops there.
 */
export function useTurnkeySession() {
  const turnkey = useTurnkey();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Pending OTP context lives in the hook so the LoginModal can hand the
  // code back without round-tripping through React state in App.
  const [pendingOtp, setPendingOtp] = useState<{
    otpId: string;
    otpEncryptionTargetBundle: string;
    contact: string;
  } | null>(null);

  /**
   * Step 1 of email auth. Sends the OTP to the user's address. Returns the
   * otpId so the modal can show a "we sent you a code" step.
   */
  const signInWithEmail = useCallback(
    async (email: string) => {
      setBusy(true);
      setError(null);
      try {
        const { otpId, otpEncryptionTargetBundle } = await turnkey.initOtp({
          otpType: OtpType.Email,
          contact: email,
        });
        setPendingOtp({ otpId, otpEncryptionTargetBundle, contact: email });
        return otpId;
      } catch (e) {
        setError(formatError(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [turnkey],
  );

  /**
   * Step 2 of email auth. Uses Turnkey's `completeOtp` which atomically
   * verifies the code and then performs login-or-signup. Signup goes
   * through the Auth Proxy which holds the parent-org API key and
   * creates the per-user sub-org server-side.
   */
  const completeEmail = useCallback(
    async (code: string) => {
      if (!pendingOtp) {
        throw new Error("No pending email OTP. Call signInWithEmail first.");
      }
      setBusy(true);
      setError(null);
      try {
        await turnkey.completeOtp({
          otpId: pendingOtp.otpId,
          otpCode: code,
          otpEncryptionTargetBundle: pendingOtp.otpEncryptionTargetBundle,
          contact: pendingOtp.contact,
          otpType: OtpType.Email,
        });
        setPendingOtp(null);
      } catch (e) {
        setError(formatError(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [pendingOtp, turnkey],
  );

  /**
   * Google OAuth. `handleGoogleOauth` opens a popup (or redirects when
   * `openInPage: true`), retrieves the OIDC id_token with our ephemeral
   * public key bound as the `nonce`, then routes through the Auth Proxy
   * to either log the user in or create a new sub-org. No backend on
   * our side.
   */
  const signInWithGoogle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const clientId = import.meta.env.VITE_TURNKEY_GOOGLE_CLIENT_ID ?? "";
      if (!clientId) {
        throw new Error(
          "VITE_TURNKEY_GOOGLE_CLIENT_ID is not set. Register Google in the " +
            "Turnkey dashboard and paste the client id into .env.",
        );
      }
      // Popup flow. The opener (this tab) polls the popup's URL and
      // closes it once it lands on our origin with the OAuth hash. That
      // polling requires `Cross-Origin-Opener-Policy: same-origin-allow-popups`
      // on the opener so reads of `popup.closed` aren't severed when
      // the popup transitions through accounts.google.com.
      // See vite.config.ts `server.headers`.
      await turnkey.handleGoogleOauth({
        primaryClientId: clientId,
        openInPage: false,
      });
    } catch (e) {
      setError(formatError(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [turnkey]);

  /**
   * X (Twitter) sign-in. Same popup pattern as Google but the upstream
   * flow is OAuth 2.0 + PKCE rather than OIDC. The Client Secret lives
   * inside Turnkey as a "Credential" (Wallet Kit → OAuth 2.0 tab), not
   * in our env — we only pass the public Client ID.
   *
   * Requires:
   *   1. An X Developer app (Web App, with `http://localhost:5173` in
   *      the callback URLs).
   *   2. A Turnkey OAuth 2.0 credential storing the X Client ID + Secret,
   *      attached to the X provider in Wallet Kit → Social Logins.
   *   3. `VITE_TURNKEY_X_CLIENT_ID` in `.env` (the same Client ID as the
   *      one in the Turnkey credential).
   */
  const signInWithX = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const clientId = import.meta.env.VITE_TURNKEY_X_CLIENT_ID ?? "";
      if (!clientId) {
        throw new Error(
          "VITE_TURNKEY_X_CLIENT_ID is not set. Create an X developer " +
            "app, store its Client ID + Secret as a credential in the " +
            "Turnkey dashboard's OAuth 2.0 tab, attach the credential " +
            "to X under Social Logins, and paste the Client ID here.",
        );
      }
      await turnkey.handleXOauth({
        primaryClientId: clientId,
        openInPage: false,
      });
    } catch (e) {
      setError(formatError(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [turnkey]);

  /**
   * Add a WebAuthn passkey to the *current* Turnkey session. This binds
   * a passkey credential to the same sub-org so the user can later log
   * back in without their email or Google account.
   */
  const attachPasskeyToWallet = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await turnkey.handleAddPasskey({});
    } catch (e) {
      setError(formatError(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [turnkey]);

  /**
   * Create a default embedded wallet with one Ethereum account on the
   * current sub-org. Only useful when the sub-org template didn't auto-
   * create one at signup (you can verify by checking the diagnostic log
   * after sign-in — if `wallets` only contains a `source: "connected"`
   * entry, this is the missing step).
   *
   * Production answer is to fix the Auth Proxy sub-org template in the
   * Turnkey dashboard so new signups get the wallet automatically. This
   * button is for unblocking existing sub-orgs without re-signup.
   */
  const createDefaultWallet = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await turnkey.createWallet({
        walletName: "Default",
        accounts: ["ADDRESS_FORMAT_ETHEREUM"],
      });
      await turnkey.refreshWallets();
    } catch (e) {
      setError(formatError(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [turnkey]);

  const logout = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await turnkey.logout({});
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }, [turnkey]);

  const session = turnkey.session;

  /**
   * Find the first ETHEREUM-format account on an EMBEDDED wallet.
   *
   * `turnkey.wallets` includes both `source: "embedded"` (Turnkey-managed
   * keys we can sign with via the API) AND `source: "connected"`
   * (external wallets the user authenticated with via wallet-stamper —
   * MetaMask, Coinbase, etc.). Turnkey's `signRawPayload` only works
   * against embedded wallet accounts; passing a connected wallet's
   * address as `signWith` returns "Could not find any resource" because
   * the API has no key material for it.
   *
   * If the only wallet present is a connected one, the sub-org has no
   * embedded wallet yet — the `getSigner()` call below refreshes and
   * gives a clearer error.
   */
  const ethAccount = (() => {
    for (const w of turnkey.wallets ?? []) {
      if (w.source !== "embedded") continue;
      const hit = w.accounts?.find(
        (a) => a.addressFormat === "ADDRESS_FORMAT_ETHEREUM",
      );
      if (hit) return hit;
    }
    return undefined;
  })();
  const address = ethAccount?.address ?? null;
  // Connection is "there is a Turnkey session" — independent of whether
  // an embedded Ethereum wallet has materialized. The session can exist
  // without an embedded wallet (e.g. the sub-org template was customized
  // to skip wallet creation, or the only wallet present is a connected
  // external wallet via wallet-stamper). Signing-time checks in
  // getSigner() handle the missing-wallet case with a clearer error.
  const isConnected = Boolean(session);

  /**
   * Build a viem LocalAccount that signs through Turnkey.
   *
   * If no Ethereum account is cached locally, we call `refreshWallets()`
   * first — the session may have been hydrated before the Auth Proxy
   * finished creating the sub-org's default wallet, in which case the
   * cached list is empty.
   */
  const getSigner = useCallback(async (): Promise<LocalAccount> => {
    if (!session) {
      throw new Error("No Turnkey session. Sign in first.");
    }
    if (!turnkey.httpClient) {
      throw new Error(
        "Turnkey httpClient is not initialized. The SDK has a session " +
          "but no bound client — this should not happen; refresh the page.",
      );
    }

    let acct = ethAccount;
    if (!acct) {
      const refreshed = await turnkey.refreshWallets();
      for (const w of refreshed ?? []) {
        if (w.source !== "embedded") continue;
        const hit = w.accounts?.find(
          (a) => a.addressFormat === "ADDRESS_FORMAT_ETHEREUM",
        );
        if (hit) {
          acct = hit;
          break;
        }
      }
    }

    if (!acct) {
      throw new Error(
        "Turnkey sub-org has no embedded Ethereum wallet account. " +
          "Connected (external) wallets like MetaMask/Coinbase show up in " +
          "`turnkey.wallets` too but can't be signed via the Turnkey API. " +
          "Check the Auth Proxy's sub-org template in the dashboard — the " +
          "default embedded wallet must include an ADDRESS_FORMAT_ETHEREUM " +
          "account. Existing sub-orgs are not backfilled when you change " +
          "the template; sign up with a fresh email to test.",
      );
    }

    return createAccountWithAddress({
      client: turnkey.httpClient,
      organizationId: session.organizationId,
      signWith: acct.address,
      ethereumAddress: acct.address,
    });
  }, [ethAccount, session, turnkey]);

  return useMemo(
    () => ({
      isConnected,
      address,
      session,
      pendingOtp,
      busy,
      error,
      signInWithEmail,
      completeEmail,
      signInWithGoogle,
      signInWithX,
      attachPasskeyToWallet,
      createDefaultWallet,
      logout,
      getSigner,
    }),
    [
      isConnected,
      address,
      session,
      pendingOtp,
      busy,
      error,
      signInWithEmail,
      completeEmail,
      signInWithGoogle,
      signInWithX,
      attachPasskeyToWallet,
      createDefaultWallet,
      logout,
      getSigner,
    ],
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
