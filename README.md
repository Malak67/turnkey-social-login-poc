# Turnkey POC — Turnkey as the signer, wagmi stays ours

A React + Vite + TypeScript proof-of-concept showing how to use **Turnkey
purely for embedded-wallet auth** (Google OAuth, X OAuth, email OTP,
passkey attachment) while **owning our own wagmi config end-to-end**.
Turnkey produces a viem `LocalAccount` and stops there.

This POC is one of three in `Social-Wallet/` evaluating vendors for the ENS
social-login layer:

- `../para-headless-poc/` — Para
- `Social-Wallet/turnkey-poc/` — Turnkey (this POC)
- `../web3auth-poc/` — Web3Auth (separate agent)

The brief is in `../vendors.md`. The lesson from the Para POC that motivates
every part of this one is "Risk 1 — the decoupling depends on an
undocumented internal gate." We re-evaluated that risk for Turnkey here.

---

## What this POC tests

> Can we use Turnkey purely as a signer-producer for social/email auth,
> with our own `WagmiProvider` as the *only* `WagmiProvider` in the tree,
> and the Turnkey-produced signer satisfying viem's `Account` interface?

**Short answer: yes, with materially less risk than Para.** Turnkey does
not ship a `WagmiProvider` and has zero `wagmi` imports across its
React/JS packages. The "decoupling" is *the default state*, not a
behavioural contract gated on an undocumented prop. The runtime
assertion is here as a tripwire regardless, per the brief.

In-scope for this POC:

1. **Wagmi non-takeover** — gating runtime assertion.
2. **Social/email auth** — Google OAuth, X OAuth, email OTP → viem `Account`.
3. **Turnkey passkey attach** on the same wallet (re-auth without
   Google/email).
4. **WalletConnect, both directions:**
   - *Inbound*: external EOAs (MetaMask, Coinbase, etc.) connect into
     this app via wagmi's `walletConnect()` connector.
   - *Outbound*: this app exposes the Turnkey wallet to arbitrary
     third-party dApps via `@reown/walletkit`. Live-tested with a
     sibling app at `../test-dapp/`.
5. **Custom wagmi connector** that surfaces the Turnkey signer through
   `useConnection()`, collapsing what would otherwise be a dual-state
   Turnkey-vs-wagmi tax into a single canonical address source.
6. **Bundle report.**

**Rhinestone smart-account integration and the SCA-variant of the
WalletConnect bridge are deferred** — those address hard requirements
3 and 4 from `vendors.md` (and the SCA half of #5). The WC bridge code
is signer-shape agnostic; pointing it at a Rhinestone SCA later is
mechanical once the SCA itself exists.

---

## Architecture

```
QueryClientProvider
└─ WagmiProvider                  ← src/wagmi.ts — the ONLY WagmiProvider
   └─ TurnkeyProvider             ← @turnkey/react-wallet-kit (headless)
      └─ WagmiBootAssertion       ← throws if useConfig() !== wagmiConfig
         └─ App
```

Two independent connection states (same shape as the Para POC):

| Source                  | State hook                              |
| ----------------------- | --------------------------------------- |
| Turnkey social/passkey  | `useTurnkey()` via `useTurnkeySession()`|
| External wallet         | `useConnection()` from `wagmi`          |

Key files:

**Provider tree + assertions**

- `src/wagmi.ts` — standalone wagmi config (EIP-6963 discovery, WalletConnect inbound connector, custom Turnkey connector)
- `src/providers.tsx` — provider tree + missing-env gate + **`WagmiBootAssertion`**
- `src/main.tsx` — popup-context guard (skips full app mount in OAuth popups)

**Turnkey auth + signer**

- `src/auth/useTurnkeySession.ts` — headless Turnkey hook (OTP, Google, X, passkey, wallet creation, signer)
- `src/auth/LoginModal.tsx` — Google + X + email OTP + external-wallet UI
- `src/auth/WalletList.tsx` — external wallets from wagmi (filters out the programmatic Turnkey connector)
- `src/auth/AccountStatus.tsx` — session view, signer round-trip, create-wallet button, passkey attach, embeds the WC panel

**wagmi connector wrapping the Turnkey signer**

- `src/turnkey-connector.ts` — custom wagmi connector + an EIP-1193 shim that routes `personal_sign` / `eth_signTypedData_v4` / `eth_sendTransaction` to the Turnkey `LocalAccount`
- `src/auth/useTurnkeyWagmiBridge.ts` — lifecycle hook that installs the signer on the connector after sign-in (auto-creates an Ethereum wallet if the sub-org template didn't), and tears it down on sign-out

**Outbound WalletConnect bridge (the wallet's "I am a wallet" side)**

- `src/walletconnect/wallet.ts` — initialise `@reown/walletkit`, handle `session_proposal` (auto-approve with the Turnkey address), handle `session_request` (dispatch to the Turnkey signer)
- `src/walletconnect/useWalletConnectBridge.ts` — React hook: `pair(uri)`, active sessions list, recent requests log
- `src/walletconnect/WalletConnectPanel.tsx` — UI: paste-`wc:`-URI input + active sessions + recent requests

**Infrastructure**

- `scripts/audit-wagmi-providers.mjs` — CI-style scan of vendor `node_modules` for `WagmiProvider` / `wagmi` imports
- `bundle-report.html` — committed `rollup-plugin-visualizer` output
- `vite.config.ts` — `Cross-Origin-Opener-Policy: unsafe-none` for the OAuth popup flow (dev only; tighten for prod)

---

## Hard-requirement verification

The seven hard requirements live in `../vendors.md`. Items 3–5 are out of
scope for this POC per the user.

### 1. Vendor must NOT take over wagmi — **PASS** (live-verified)

Three independent checks all pass:

**1a. Static check** — `npm run audit:wagmi-providers` scans
`node_modules/@turnkey/*`, `@reown/*`, `@walletconnect/*` (and the
deferred `@rhinestone/*`) for any file importing from `wagmi` or naming
`WagmiProvider`. Result:

```
scanning @turnkey/...
scanning @rhinestone/...
scanning @reown/...
scanning @walletconnect/...

✓ no WagmiProvider / wagmi imports in vendor packages
```

**1b. Type-level check** — `node_modules/@turnkey/react-wallet-kit/dist/index.d.ts`
exports `TurnkeyProvider`, `useTurnkey`, `useModal`, and re-exports from
`@turnkey/core` — no `WagmiProvider` export. Inspected directly.

**1c. Runtime check** — `src/providers.tsx:73-79` wraps the app in a
`WagmiBootAssertion` component that calls `useConfig()` from `wagmi` and
throws with a referenced error message if it does not return the exact
`wagmiConfig` instance from `src/wagmi.ts`. This is the tripwire that
fires if a future Turnkey SDK update mounts a competing `WagmiProvider`:

```tsx
function WagmiBootAssertion({ children }: { children: ReactNode }) {
  const observed = useConfig();
  if (observed !== wagmiConfig) {
    throw new Error("[turnkey-poc] useConfig() did not return …");
  }
  return <>{children}</>;
}
```

Compared to the Para POC's posture, this is materially safer: Para's
decoupling depended on an undocumented internal gate (`!externalWalletConfig`)
in `@getpara/react-sdk-lite`. Turnkey ships no wagmi code at all — the
decoupling is the package's default state.

### 2. Vendor must produce a standard signer — **PASS** (live-verified)

Live test: signed `"hello from turnkey-poc"` from the browser using the
Turnkey-backed viem `LocalAccount` — round-trip succeeded.

Code: `src/auth/useTurnkeySession.ts:getSigner()` returns
`createAccountWithAddress({ client: turnkey.httpClient, organizationId, signWith: address, ethereumAddress: address })`
from `@turnkey/viem`. The returned object satisfies the full viem
`Account` interface:

| Capability | Method | Live-verified? |
|---|---|---|
| EIP-191 (`personal_sign`) | `signMessage({ message })` | ✅ |
| EIP-712 typed data | `signTypedData(td)` | typed-only |
| EIP-155 transactions | `signTransaction(tx)` | typed-only |
| Raw hash (for ERC-4337) | `sign({ hash })` | typed-only |
| EIP-7702 authorisations | `signAuthorization(...)` | typed-only |

The address is stable: it's derived from the sub-org's wallet
`account.address` field, available immediately after the session loads.

### 3. Rhinestone integration — **deferred** (out of scope per user)

Mechanically the Turnkey signer slots into
`rhinestoneSDK.createAccount({ owners: { type: "ecdsa", accounts: [signer] } })`
because it's a vanilla viem `LocalAccount`. The bring-up is the same for
all three POCs.

### 4. Passkey co-validator on the SCA — **deferred** (out of scope per user)

Note: this POC *does* expose Turnkey's own passkey attach (the "Add a
passkey to this Turnkey wallet" button). That binds a WebAuthn
credential to the Turnkey sub-org so the user can re-auth to Turnkey via
passkey — it's not the same thing as a Rhinestone SCA passkey
co-validator. Hard requirement #4 is about installing a passkey
validator on the smart account so the SCA is usable independently of
Turnkey; that's deferred.

### 5. WalletConnect exposure of the wallet — **PASS** (live-verified, SCA-variant deferred)

Two directions of WalletConnect:

**Inbound** — `wagmi/connectors → walletConnect()` lets external
wallets (MetaMask, Coinbase, etc.) connect *into* this app. Wired
in `src/wagmi.ts`. Tested by scanning the wagmi QR from a mobile
wallet.

**Outbound — built and live-tested.** This POC now exposes the
Turnkey-backed wallet *out* to any third-party dApp via
`@reown/walletkit`. See `src/walletconnect/wallet.ts` (the bridge),
`src/walletconnect/useWalletConnectBridge.ts` (the React hook), and
the "Wallet (outbound WalletConnect)" section in the
AccountStatus card. A sibling app at `Social-Wallet/test-dapp/`
plays the role of a generic third-party dApp; it has zero Turnkey
code and connects to the wallet purely through WalletConnect.

Live-tested end-to-end: dApp generates `wc:` URI → user pastes into
wallet → wallet auto-approves → dApp's `useConnection()` shows the
Turnkey address → dApp signs messages / typed data / sends
transactions, all routed through the Turnkey signer.

The SCA-variant of this requirement — exposing a *Rhinestone SCA*
(not the bare Turnkey EOA) via WalletConnect — is still deferred
along with the rest of the SCA work. The bridge code is signer-shape
agnostic; swapping the EOA for an SCA at the dispatch layer is
mechanical.

### 6. Bundle and runtime cost — **measured**

`npm run build` output (rolldown):

```
dist/   ~5.7 MB total
  ~80 JS chunks
  2.4 MB index-*.js (largest single chunk; Turnkey + WC bridge core)
  660 KB nodecrypto chunk     ← Node-builtins polyfill for WC
  336 KB lottie-react chunk   ← Turnkey wallet-kit's animation runtime
  164 KB w3m-modal            ← Reown Web3Modal
  140 KB ApiController        ← @reown/appkit
  + brotli_wasm WASM blob for the WC relay
```

Bundle report committed at `bundle-report.html`.

**This is materially larger than the same POC was without WalletConnect.**
Adding `@walletconnect/ethereum-provider` (peer dep needed by wagmi's
`walletConnect()` connector) installed **154 transitive packages** and
landed dozens of `@reown/*` and `@walletconnect/*` chunks. Most of that
is **WalletConnect's cost, not Turnkey's** — but it's hard to attribute
cleanly because both vendors share `@walletconnect/sign-client`.

**Top Turnkey contributors:**

- `@turnkey/react-wallet-kit` + `@turnkey/core` (the bulk of the auth
  surface)
- `@lottiefiles/react-lottie-player` — Turnkey's wallet-kit imports this
  unconditionally at module top-level even with `renderModalInProvider:
  false`. ~336 KB. This is Turnkey's equivalent of Para's "Solana
  connectors ship despite zero Solana usage."
- `@turnkey/iframe-stamper`, `indexed-db-stamper`, `webauthn-stamper` —
  authentication primitives.
- `nodecrypto` shim — 660 KB; `vite-plugin-node-polyfills` shimming
  `Buffer`/`process` for the WalletConnect runtime.

**Forced transitive dep found:**

- **`ethers ^6.10.0` is a runtime dependency of `@turnkey/core@2.0.0`**
  (verified at `node_modules/@turnkey/core/package.json`). Installed
  on disk (`node_modules/@turnkey/react-wallet-kit → @turnkey/core →
  ethers@6.16.0`). The final bundle does *not* contain ethers symbols
  (`grep BrowserProvider|JsonRpcSigner` returns zero hits) — tree-shaken
  out — but the package weighs ~5 MB at install. **This mirrors the
  Para finding** (Para also pulled `ethers v6` despite us using viem),
  with the difference that Para's bundle *did* contain ethers code
  whereas Turnkey's tree-shakes successfully.

### 7. No platform wrapping — **PASS**

- `TurnkeyProvider` is configured with `ui: { renderModalInProvider:
  false }`. We never call `handleLogin()` — Turnkey's hosted modal is
  never instantiated.
- No "Turnkey smart wallet" product is used. The Turnkey wallet is just
  the key pair (one ETH account on an embedded wallet).
- Turnkey contributes zero wagmi connectors. `src/wagmi.ts` is the only
  source of inbound EOA connectors.

---

## Per-vendor findings — discovered during integration

These are answers to the "Turnkey-specific risks to investigate" list in
`vendors.md`, updated based on what we actually hit while wiring it up.

### Sub-organisation lifecycle

- **Creation (per-user sub-org):** **works automatically** via Turnkey's
  hosted Auth Proxy. The browser SDK calls `proxyInitOtpV2` /
  `proxyOAuth2Authenticate` / `proxySignupWith*`, the proxy stamps a
  `CREATE_SUB_ORGANIZATION_V7` activity with the parent-org API key, the
  sub-org is created server-side, and the new session token is returned
  to the browser. **No backend on our side.** This was the single biggest
  risk going in; it's resolved by enabling Auth Proxy in the dashboard.
- **Default wallet on signup: does NOT happen by default — this is a
  meaningful divergence from Para.** New sub-orgs come up with **zero
  embedded wallets** unless the Auth Proxy's "sub-org template" is
  configured to auto-create one.

  The model difference: Para couples auth and wallet (one user = one
  MPC-shared key, always created at signup, no "user without wallet"
  state). Turnkey decouples them — a sub-org can have zero, one, or
  many embedded wallets, plus optionally connected external wallets.
  That flexibility is useful for some products but for ENS we want
  Para's "wallet always present after social auth" UX.

  **Reaching Para UX on Turnkey takes two things:**

  1. **Dashboard fix (production answer):** configure the Auth Proxy
     sub-org template so new sub-orgs auto-create an
     `ADDRESS_FORMAT_ETHEREUM` account on every signup. Existing
     sub-orgs are not backfilled when you change the template.
  2. **Defensive auto-create in the bridge (code answer):** the
     `useTurnkeyWagmiBridge` hook detects "session exists but no
     embedded ETH wallet" and calls
     `turnkey.createWallet({ walletName: "Default", accounts: ["ADDRESS_FORMAT_ETHEREUM"] })`
     before the wagmi connect step. This makes the user-visible UX
     match Para's even when the dashboard isn't yet configured.

  Wallet creation is free in Turnkey's per-signature pricing, so the
  defensive auto-create has no real cost.

  A manual "Retry creating an embedded Ethereum wallet" button is
  kept in `AccountStatus.tsx` purely as an escape hatch if the
  auto-create errors (network, dashboard policy change). It should
  never appear in the happy path.
- **Connected vs. embedded wallets:** `turnkey.wallets` lists BOTH
  embedded wallets (Turnkey-managed keys we can sign with via the API)
  AND any connected external wallets (e.g. MetaMask/Coinbase
  authenticated via wallet-stamper). `signRawPayload` only works against
  embedded wallets — passing a connected wallet's address returns
  `Turnkey error 5: Could not find any resource to sign with.` This
  cost real debugging time; the fix is to filter by `wallet.source ===
  "embedded"` before reading `accounts[0].address`. The Turnkey docs do
  not call this out.
- **Deletion:** Turnkey exposes a `DELETE_SUB_ORGANIZATION` activity
  but it is stamped by the **parent-org API key**, not by the end user.
  So in production ENS would either (a) operate a small backend
  endpoint that deletes sub-orgs on user request, or (b) leave dormant
  sub-orgs in place (they cost nothing — pricing is per-signature, not
  per-org). Both are workable; (a) is cleaner for GDPR right-to-be-forgotten.
- **Migrating off Turnkey:** Turnkey ships a user-facing key export
  flow (`handleExportWallet`) — see "Key export" below. Migrating
  *all* users off Turnkey at once is not a one-call operation — it
  requires coordinating with users.

### Key export — **supported, user-controlled**

`handleExportWallet`, `handleExportPrivateKey`, `handleExportWalletAccount`
in `useTurnkey()`. End user gets the raw mnemonic / private key through
a Turnkey iframe (`export.turnkey.com`); neither our app nor Turnkey's
enclave operators see the plaintext (HPKE encryption inside the
enclave, decryption inside the iframe). This is the **strongest answer
of the three vendors on Q3 "recovery story"** — it's the
self-custodial-key-export option from `vendors.md` directly.

### Auth-method recovery

- If the user loses their passkey but still has email / Google / X: log
  in via one of those, then re-attach a new passkey via
  `handleAddPasskey`. We have the button wired in `AccountStatus.tsx`.
- If the user loses **all** of email + Google + X + passkey: Turnkey's
  recovery paths require either a backup recovery factor configured at
  signup or, for sub-orgs created via Auth Proxy, parent-org
  intervention. ENS would need to publish an explicit recovery policy.
- For ENS specifically, the cleanest answer combines this with the
  smart-account layer: a passkey or guardian co-validator on the
  Rhinestone SCA means the user can sign even if Turnkey is unreachable.
  That's why hard requirement #4 exists in the brief.

### Pricing at ENS scale

- **Pricing is per-signature**, not per-MAU and not per-API-call.
  Wallet creation itself is free.
- Published tiers (as of POC date):
  - Free: 100 wallets, 25 sigs/mo
  - PAYG: $0.10/sig
  - Pro: $99/mo + $0.05/sig
  - Enterprise (custom): as low as $0.0015/sig for high volume
- **For ENS at millions of MAU:** at $0.0015/sig the unit cost is
  acceptable, but the total scales with *how often users sign*. The
  variable that dominates is "do we batch via session keys." If we
  operate a Rhinestone SCA with session-key UX, chargeable Turnkey
  signatures drop dramatically — but that's an architectural decision,
  not a Turnkey one.
- Inactive users cost nothing — that's a cleaner pricing shape than
  per-MAU for our use case.

### Social-login providers — what we actually wired up

| Provider | Status | Flow type | Effort to wire |
|---|---|---|---|
| **Google** | ✅ working live | OIDC (id_token in URL hash) | Low. Just register the OIDC Client ID in the Turnkey dashboard + `.env`. |
| **X (Twitter)** | ✅ working live | OAuth 2.0 + PKCE (confidential client) | Medium. Requires creating an OAuth 2.0 *credential* (Client ID + Secret) in Turnkey's dashboard OAuth 2.0 tab (because X needs a server-side client secret). X's own developer UI hides OAuth 2.0 under "User authentication settings → Set up". |
| **Email OTP** | ✅ working live | OTP via Auth Proxy | Low. Enabled via toggle in dashboard. |
| **Passkey (attach)** | ✅ working live | WebAuthn | Low. `handleAddPasskey({})`. |
| **Apple / Discord / Facebook** | not implemented | Same shape as Google / X | Should work — same SDK surface, same dashboard mechanism. |
| **Telegram — deferred (per Q1)** | not implemented | Custom JWT verifier required | Out of scope per the brief. Path: Telegram Login Widget → validate signed payload against bot token → mint OIDC-shaped JWT → serve JWKS → register as a custom OIDC provider in Turnkey. Carries backend ops cost. |

### Integration gotchas we hit (worth noting for the comparison)

Each of these cost real debugging time and is *not* covered in Turnkey's
docs as of the integration date:

1. **`turnkey.wallets[]` mixes embedded and connected wallets.** Filter
   by `source === "embedded"` to find the signable one. Otherwise
   `signRawPayload` fails with "Could not find any resource."
2. **`accounts[]` is not guaranteed to contain an Ethereum-format
   account.** Filter by `addressFormat === "ADDRESS_FORMAT_ETHEREUM"`.
3. **Auth Proxy sub-org template does not include a default wallet
   unless configured to.** Sub-orgs come up empty; either configure the
   template or call `createWallet` from the client.
4. **OAuth requires three separate dashboard touches**, even though
   only one looks needed:
   - Enable the provider toggle (Social Logins → Google / X)
   - Paste the Client ID into the per-provider field
   - **Also** add the same Client ID to the "Social Linking → Google
     Whitelisted Client IDs" list (the UI is labelled "Google" but it's
     a generic cross-provider whitelist — without an entry here, "Save
     Changes" stays disabled)
5. **X needs OAuth 2.0, not OAuth 1.0a.** X's developer console
   shows OAuth 1.0a credentials by default (Consumer Key, Bearer Token).
   OAuth 2.0 lives under "User authentication settings → Set up" and
   only shows the Client ID + Client Secret once after configuration.
6. **The OAuth `oauthRedirectUri` must be set in code** (in
   `TurnkeyProvider` config), and exactly matched in three other places:
   - Google Cloud Console → Authorized redirect URIs
   - Turnkey dashboard → Social Logins → Redirect URL
   - X Developer Portal → Callback URI / Redirect URL
   Whitespace, trailing slash, `http` vs `https`, and `localhost` vs
   `127.0.0.1` all cause `redirect_uri_mismatch`.
7. **Vite's dev server defaults to `Cross-Origin-Opener-Policy:
   same-origin`,** which breaks the OAuth popup flow — the opener can't
   poll the popup's URL through the cross-origin redirect to Google/X.
   `vite.config.ts` sets COOP to `unsafe-none` for dev. Tighten in
   production.
8. **The OAuth popup loads the full app inside the popup by default.**
   `src/main.tsx` adds a popup-detection guard that renders a small
   "Completing sign-in…" placeholder instead, so the popup doesn't try
   to consume the OAuth state itself (which would race with the opener
   and fail with "Missing OAuth state in storage").
9. **`@walletconnect/ethereum-provider` is a missing peer dep of wagmi's
   `walletConnect()` connector.** Not declared in any package's
   `dependencies`, but required at runtime — silent failure otherwise.
10. **wagmi v3's deprecated aliases.** `useAccount`, `connect`,
    `disconnectAsync`, `signMessageAsync` are all deprecated in favour
    of `useConnection`, `mutate`, `mutateAsync`. Same behaviour, just
    renamed. Migrating to the new names removes the deprecation
    warnings from the IDE.

---

## Caveats & risks

Modeled on the Para POC's Risk 1 / 2 / 3 structure.

### Risk 1 — The wagmi decoupling is the default, but a vendor refactor could still pull wagmi in

Para's SDK *has* a `WagmiProvider` and merely happens not to mount it
when one specific prop is omitted; Turnkey's SDK has *no* wagmi code in
it. That is the default state, not a contract. Three concrete ways this
could change:

- **Turnkey adds a wagmi connector / provider package.** A future major
  release of `@turnkey/react-wallet-kit` could ship or auto-mount such
  a thing.
- **A transitive bump pulls a wagmi-coupled adjacent package.**
  `@turnkey/core` already depends on `@walletconnect/sign-client`. The
  WalletConnect ecosystem has converged with wagmi via Reown's
  AppKit. A future `@walletconnect/*` major could pull wagmi as a peer
  dep.
- **Refactor of `TurnkeyProvider` to wrap children in a wagmi-adjacent
  provider** (Reown AppKit's `WagmiAdapter`, a wallet manager that
  internally calls `createConfig`).

**Mitigations baked into this POC:**

- `npm run audit:wagmi-providers` is wired and passes today. Wire it
  into CI on production builds.
- `WagmiBootAssertion` in `src/providers.tsx` throws at boot if
  `useConfig()` returns anything but `src/wagmi.ts`'s `wagmiConfig`.
- Pin `@turnkey/react-wallet-kit`, `@turnkey/core`, `@turnkey/viem` to
  exact versions before production, not the caret ranges in
  `package.json` today. Re-run the audit on every bump.

**Verdict:** materially safer than the Para shape, but not zero risk.

### Risk 2 — Dual connection state, same as the Para POC

Inherited from the architecture. Turnkey and wagmi each maintain their
own state; everything in Risk 2 of the Para POC's README applies here
unchanged:

- Three terminal connected states: Turnkey only, wagmi only, both.
- Sign-out has to call both `tk.logout()` and the wagmi
  `mutateAsync` from `useDisconnect()`.
- Page reload: each side restores from its own persistence (Turnkey
  uses IndexedDB; wagmi uses localStorage).
- No single canonical "the user's address" — decide per surface.
- Errors and loading states have different shapes per source.

Mitigation: build an app-level `useSession()` returning
`{ address, chainId, source, signOut }` and ban direct calls outside
it. Turnkey-specific wrinkle: when the Rhinestone SCA layer is added,
there will be **three** sources to reconcile — Turnkey session, wagmi
session, and SCA validator selection.

### Risk 3 — Bundle cost is moderate; WalletConnect dominates

- Total dist: 5.3 MB across 79 JS chunks (Vite split heavily because of
  Reown AppKit + WalletConnect).
- The Turnkey-specific overhead is ~700–800 KB pre-WalletConnect
  (`@turnkey/*` packages + Lottie player + iframe-stamper).
- WalletConnect alone adds ~3 MB (Reown AppKit chunks + brotli WASM).
- `ethers@6` is installed but tree-shaken out of the bundle.
- `@lottiefiles/react-lottie-player` ships unconditionally because the
  Turnkey wallet-kit imports it at module top-level. Turnkey's
  equivalent of Para's Solana-connectors cost.

**Mitigations:**

- Run `rollup-plugin-visualizer` on every build (already wired) and
  treat regressions as PRs to fix.
- Pin Turnkey package versions exactly and audit transitive ranges on
  upgrade.
- If the bundle becomes a problem, consider lazy-loading
  `<TurnkeyProvider>` so its init does not block first paint.

### Other notes

- `TurnkeyProvider` mounts its own React contexts, query observers, and
  lifecycle (iframe stamper, indexed-db storage, session refresh
  timers). "Headless" ≠ "no runtime."
- Turnkey's persisted session lives in **IndexedDB**; wagmi's persisted
  connector lives in **localStorage**. Each survives reload via its own
  storage; clearing one does not clear the other.
- `VITE_`-prefixed env vars are bundled into the client.
  `VITE_TURNKEY_ORGANIZATION_ID`, `VITE_TURNKEY_AUTH_PROXY_CONFIG_ID`,
  `VITE_TURNKEY_GOOGLE_CLIENT_ID`, `VITE_TURNKEY_X_CLIENT_ID`,
  `VITE_WALLETCONNECT_PROJECT_ID` are all public, domain-restricted
  identifiers. **The parent-org API key never appears in the client**
  because the Auth Proxy holds it. The X **Client Secret** lives only
  in Turnkey's credential store, never in `.env`.

---

## Conditions for using this in production

Mirroring the Para POC. Picking Turnkey is viable, but commits the team
to all three of the following.

### 1. We will close Risk 1 before this becomes a real users' login flow

- Add `npm run audit:wagmi-providers` to CI so any future vendor
  package that introduces wagmi fails the build.
- Pin `@turnkey/react-wallet-kit`, `@turnkey/core`, `@turnkey/viem`,
  `@turnkey/sdk-types`, `@turnkey/sdk-browser` to exact versions (drop
  the caret) and treat upgrades as audited changes. Verify the audit
  passes on every bump.
- Keep `WagmiBootAssertion` in the provider tree. It is cheap and it
  fires *before* user data hits a wrong config. Do not let a future PR
  remove it for "cleanup."

### 2. We accept the dual-state complexity tax indefinitely

Same shape as Para's Risk 2. Two parallel connection states require an
app-level abstraction (`useSession()`) and disciplined sign-out paths.
This will grow to *three* states once the Rhinestone SCA layer is added
— plan the abstraction with that in mind from day one.

### 3. We accept the bundle and runtime cost and commit to tracking, not eliminating, it

- Add `bundle-report.html` as a build artefact in CI. Treat regressions
  in Turnkey's share of the bundle as PRs to investigate, not to fix
  immediately.
- The Lottie animation runtime, the `ethers@6` install-time dep, the
  Reown WalletConnect transitives, and the Node polyfills are baseline
  costs. Reducing them materially requires Turnkey to refactor — not a
  us-side optimisation.
- Auth Proxy means **no backend on our side for the auth flow**, but
  one of the production conditions is "the Auth Proxy stays up." If
  Turnkey's hosted Auth Proxy is unavailable, signup is blocked. (The
  fallback is to run `@turnkey/sdk-server` ourselves with the
  parent-org API key — operational cost, but a known escape hatch.)

---

## Side-by-side comparison heuristics vs Para

| Dimension | Para | Turnkey |
|---|---|---|
| **Wagmi shadow-provider risk** | **High** — depends on an undocumented `!externalWalletConfig` gate inside `@getpara/react-sdk-lite`. Silent failure mode if Para changes that branch. | **Low** — vendor ships no wagmi code today; risk is future SDK direction, mitigated by static + runtime + CI checks. |
| **Headless mode genuinely headless?** | Yes, with caveats (modal package still mounts). | Yes — `renderModalInProvider: false` and we never call `handleLogin()`. |
| **Sub-org per user** | Yes (Para handles it). | Yes (Turnkey Auth Proxy handles it). |
| **Backend required for the POC?** | No. | No (with Auth Proxy enabled). |
| **Built-in social providers** | Google, Apple, Discord, X, Farcaster, Telegram, email, phone | Google, Apple, Discord, X, Facebook, email, phone |
| **Telegram support** | Built-in (uses `onOAuthUrl`). | Custom OIDC verifier required (deferred). |
| **Key export to user** | Not user-facing (Para's recovery is vendor-managed). | **First-class** — `handleExportWallet` via Turnkey iframe; user owns the raw mnemonic. |
| **Pricing model** | Per-MAU tiers. | Per-signature. |
| **Bundle weight (Turnkey/Para alone)** | High — Solana connectors, AA shims, ethers v6 all visible in `dist/`. | Moderate — `ethers@6` installed but tree-shaken; Lottie unavoidable. |
| **Bundle weight (with WalletConnect)** | n/a in Para POC (no WC). | ~5–6 MB total; ~3 MB attributable to Reown / WalletConnect across 79+ chunks. |
| **WalletConnect-as-wallet bridge (outbound)** | Not built; "Para Connect" is vendor-scoped, not the same thing. | **Built and live-tested in this POC** (`src/walletconnect/` + `../test-dapp/`). |
| **Dashboard UX (developer)** | Smooth. | **Several gotchas** — three-touch OAuth setup (toggle + Client ID + whitelist), sub-org template needs manual config for default wallet, X OAuth 2.0 is hidden behind "Set up". |
| **Trust model of the embedded key** | Para's MPC network holds the share. | Turnkey's secure enclaves hold the key; user can export. |
| **What happens if vendor disappears** | User can't easily migrate; recovery is via Para. | Pre-export → user has the key. Without export, parent-org API key access is needed. |

---

## Setup — the wallet alone

```bash
cd turnkey-poc/
npm install
cp .env.example .env
# edit .env with your Turnkey org id, Auth Proxy config id,
# Google client id, X client id, and WalletConnect project id
npm run dev
```

Opens on **http://localhost:5173**.

Without `VITE_TURNKEY_ORGANIZATION_ID` /
`VITE_TURNKEY_AUTH_PROXY_CONFIG_ID`, the app renders a setup notice
instead of white-screening (`TurnkeyProvider` throws on missing config,
so we gate on the env vars in `src/providers.tsx`).

To get the values:

1. **Turnkey** — sign up at `app.turnkey.com`. Enable Auth Proxy in
   **Wallet Kit → Configuration**. Copy `Organization ID` (top-right
   user dropdown) and `Auth Proxy Config ID` (the `Config ID` value in
   the Auth Proxy box).
2. **Google** — create an OAuth 2.0 Client ID at Google Cloud Console.
   Add `http://localhost:5173` to **Authorized redirect URIs**. Paste
   the Client ID into Turnkey's **Social Logins → Google** AND the
   **Social Linking → Google Whitelisted Client IDs** list (yes, both
   — the dashboard requires it).
3. **X** — create a Developer app at `developer.x.com`, then under
   **User authentication settings → Set up** choose **Web App** and
   enable OAuth 2.0. Save the Client ID + Client Secret X shows you
   (one-time view). In Turnkey: **OAuth 2.0** tab → **Add credential**
   → X → paste both. Then back to the **Authentication** tab →
   **Social Logins → X → Select credential**.
4. **WalletConnect** — create a project at `cloud.reown.com`. Copy the
   Project ID.

Step-by-step gotchas for each are in the "Integration gotchas" section
above.

---

## Running the wallet + test-dapp together (end-to-end WC test)

To verify the outbound WalletConnect bridge, you need this app **plus**
the sibling test-dapp at `../test-dapp/`. They run on different ports
and talk over WalletConnect's real relay, not over localhost shortcuts.

```bash
# terminal 1 — the wallet (this directory)
cd turnkey-poc/
npm install            # one-time
npm run dev            # → http://localhost:5173

# terminal 2 — the test dApp
cd ../test-dapp/
npm install            # one-time
cp .env.example .env   # one-time; reuse the same VITE_WALLETCONNECT_PROJECT_ID
npm run dev            # → http://localhost:5174
```

Both apps must share the **same** `VITE_WALLETCONNECT_PROJECT_ID` —
that's how Reown's relay knows the two halves of the conversation
belong to the same project.

### The test flow

1. **Wallet tab** (`localhost:5173`) — sign in via Google / X / email.
   After auth lands you should see your Turnkey address in the account
   card with **Source: Turnkey**.
2. **dApp tab** (`localhost:5174`) — click **"Connect via WalletConnect"**.
   A Reown modal opens with a QR code. Look for the copy icon and copy
   the `wc:...` URI.
3. **Wallet tab** — scroll to **"Wallet (outbound WalletConnect)"**,
   paste the URI, click **"Connect to dApp"**. The wallet auto-approves
   the session.
4. **dApp tab** — the modal closes, `useConnection()` reports your
   Turnkey address as the connected wallet, and you can now click:
   - **"Sign a message"** — `personal_sign` round-tripped through the
     Turnkey signer
   - **"Sign typed data"** — EIP-712 variant
   - **"Send 0 ETH to myself"** — `eth_sendTransaction`, needs testnet
     ETH for gas
5. **Wallet tab** — the "Recent requests" log shows the dApp's name,
   the RPC method, and the chain ID for each request.

The test dApp has **zero Turnkey code** — it's a pure WalletConnect
consumer. Every signature traverses the real WC relay, the same path
Uniswap or OpenSea would use. If this works, the wallet is reachable
from any WalletConnect-capable dApp on the web.

See `../test-dapp/README.md` for the dApp side of this and what it
exists to prove.

---

## Scripts

- `npm run dev` — dev server (http://localhost:5173)
- `npm run build` — typecheck + production build, regenerates
  `bundle-report.html`
- `npm run preview` — preview the production build
- `npm run audit:wagmi-providers` — vendor-package WagmiProvider audit;
  add to CI

---

## Implementation notes

- **Use `@turnkey/react-wallet-kit`, not `@turnkey/sdk-react`.** Both
  exist on npm and both were published recently. The older
  `@turnkey/sdk-react@6.0.0` is superseded; mixing the two installs
  duplicate `@turnkey/core` instances and breaks session storage.
- **`OtpType` is an enum, not a string literal.** Import it from
  `@turnkey/react-wallet-kit`. Re-exported from `@turnkey/core` but the
  wallet-kit re-export is the documented path.
- **`turnkey.httpClient` is `TurnkeySDKClientBase | undefined`.** The
  hook returns undefined before the provider has finished its init.
  `useTurnkeySession.getSigner()` guards on this.
- **`handleGoogleOauth` and `handleXOauth` take `primaryClientId`,
  not `clientId`.** Named for the parent-vs-secondary OIDC client setup
  Turnkey supports.
- **`handleXOauth` exists on `useTurnkey()` even though the docs are
  light on it.** Same shape as Google's handler.
- **Node polyfills are required** because `@turnkey/core` and
  `@walletconnect/sign-client` reference `Buffer` and `process`. Same
  gotcha as the Para POC.
- **`erasableSyntaxOnly: true` is in `tsconfig.app.json`.** Blocks
  declaring local enums but does not block consuming external enums
  (`OtpType.Email` is fine).
- **wagmi's modern hook names:** `useConnection` (not `useAccount`),
  `mutateAsync` (not `disconnectAsync` / `signMessageAsync` /
  `connectAsync`). The deprecated aliases still work; using the new
  ones removes IDE warnings.

---

## Future work (deferred from this POC)

These items are from `vendors.md` and were intentionally not built:

- **Rhinestone SCA integration** — create a Nexus account with the
  Turnkey signer as the ECDSA owner; send a userOp through a bundler;
  resolve an ENS name (testnet) to the SCA address.
- **Passkey co-validator on the SCA** — install
  `@rhinestone/sdk/modules/passkey-validator` and demonstrate a userOp
  signed by the passkey only, with no Turnkey session active.
- **WalletConnect bridge against the SCA (not the EOA)** — the bridge
  is built and exposes the bare Turnkey EOA today. Pointing the same
  dispatch layer at a Rhinestone SCA is mechanical once the SCA
  itself exists.
- **Telegram OAuth** — via custom OIDC verifier in the Turnkey dashboard.
  Out of scope per Q1 of `vendors.md`.
- **Production hardening of the OAuth popup flow** — tighten the COOP
  to `same-origin-allow-popups` (instead of `unsafe-none`) and verify
  the popup flow works over HTTPS against the production origin.
- **Deploy the wallet to a public URL** — for real users this app
  needs to live at a stable origin (e.g. `wallet.ens.eth` via IPFS +
  ENS resolver, or a CDN for faster iteration). Deployment target is
  a product decision, not a code one.
- **ENS Manager app** — a sibling app at `Social-Wallet/ens-manager-poc/`
  (not yet built) that reuses the same Turnkey auth foundation and
  adds ENS-specific UI (name search, registration, records). Talks
  to the wallet via WalletConnect or shares the parent org for
  Turnkey-direct flows.

Each of these is vendor-agnostic (the Rhinestone integration is the
same shape regardless of where the signer comes from) and is the right
place to consolidate work across the three POCs once a vendor is
chosen.
