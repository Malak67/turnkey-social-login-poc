# Turnkey — Findings

This is the digestible writeup of what we learned building the Turnkey POC.
For the full hard-requirement walkthrough see `README.md`. This file is the
"what should the team know" version, intended to sit alongside equivalents
for Para and Web3Auth in a side-by-side comparison.

---

## TL;DR

Turnkey is a good fit for the "vendor produces a signer and stops there"
architecture we need for ENS. The biggest single risk we identified
going in — **wagmi takeover** — is resolved by Turnkey having zero wagmi
code in its SDK at all. That makes Turnkey materially safer than Para
on the gating concern.

We also went one step further than the brief required and **wrote our
own custom wagmi connector** that wraps the Turnkey signer. The result
is that `useConnection()` becomes the *single* source of truth for the
active wallet, regardless of whether the user signed in via Turnkey
(Google / X / email) or an external wallet (MetaMask / WalletConnect).
This collapses the dual-state complexity tax that the Para POC's "Risk
2" calls out.

The trade-offs are real but manageable: bundle weight is moderate, the
dashboard has several non-obvious gotchas, and X social-login lands in a
different sub-org than Google for the same user (unless emails match
and X is configured to share them).

---

## What's good

### 1. Wagmi takeover risk is essentially zero

`@turnkey/react-wallet-kit@2.0.0` and `@turnkey/core@2.0.0` contain
**no wagmi imports at all**. We verified this with a static
`grep`-based audit script (`scripts/audit-wagmi-providers.mjs`) and
the type-level `index.d.ts` of the package — no `WagmiProvider`
export, no `createConfig` call.

This is the cleanest possible state for the gating concern in
`vendors.md`. Compare with Para, where the decoupling depends on
omitting an undocumented `externalWalletConfig` prop — Turnkey's
decoupling is the default state of the package.

We still keep a boot-time runtime assertion (`WagmiBootAssertion` in
`src/providers.tsx`) as defence-in-depth. It fires if any future SDK
update ever mounts a competing `WagmiProvider`.

### 2. Headless mode is genuinely headless

We pass `ui: { renderModalInProvider: false }` to `TurnkeyProvider`
and never call `handleLogin()`. Turnkey's hosted modal is never
instantiated. Every flow is driven through our own UI calling the
headless hooks: `initOtp`, `completeOtp`, `handleGoogleOauth`,
`handleXOauth`, `handleAddPasskey`, `signMessage`, etc.

No vendor branding leaks into the UI unless we explicitly opt in.

### 3. The signer is a real viem LocalAccount

`@turnkey/viem`'s `createAccountWithAddress` returns a viem
`LocalAccount` that satisfies the full interface: `signMessage`
(EIP-191), `signTypedData` (EIP-712), `signTransaction` (EIP-155),
`sign({ hash })` (raw, for ERC-4337 userOps), and `signAuthorization`
(EIP-7702).

This means the Turnkey signer plugs into:

- Our custom wagmi connector — so `useConnection()` / `useSignMessage`
  / `useSendTransaction` Just Work.
- Rhinestone's `RhinestoneSDK.createAccount({ owners: { type: "ecdsa",
  accounts: [signer] } })` — when the SCA layer gets wired up.
- Any other viem-shaped abstraction.

We live-verified `signMessage` end-to-end with a "Sign hello from
turnkey-poc" button in the AccountStatus card.

### 4. User can own their private key — first-class key export

Turnkey ships **`handleExportWallet`, `handleExportPrivateKey`, and
`handleExportWalletAccount`** in `useTurnkey()`. The flow:

1. User clicks "Export" in our UI (we haven't wired the button yet but
   the hook is available).
2. Turnkey opens an iframe at `export.turnkey.com`.
3. The iframe generates a P-256 Target Encryption Key locally.
4. Turnkey's enclave HPKE-encrypts the mnemonic/private key to the TEK
   and returns the ciphertext to the iframe.
5. The iframe decrypts and displays the raw mnemonic / private key to
   the user.

**Neither our app nor Turnkey's enclave operators see the plaintext.**
The user walks away with the actual key material and can import it
into any standard wallet (MetaMask, Rabby, Ledger, etc.).

This is the strongest answer to "what happens if the vendor disappears"
of any of the three vendors. If Turnkey shuts down tomorrow, every user
who exported their key has full self-custody. For ENS-as-identity-infra
this is non-negotiable, and Turnkey delivers it without us having to
build it.

### 5. Sub-org-per-user model is operationally clean

Each end-user gets their own Turnkey **sub-organisation**. We
configured Turnkey's hosted **Auth Proxy** in the dashboard, which
means:

- Our app never holds the parent-org API key.
- Sub-org creation on first login is automatic — the proxy stamps
  `CREATE_SUB_ORGANIZATION_V7` server-side using the parent key.
- The browser-only POC works with no backend on our side.

If we ever need backend control (e.g. for sub-org deletion, custom
policies), we install `@turnkey/sdk-server` and call the API
directly. The escape hatch is documented.

### 6. Per-signature pricing — inactive users cost nothing

Turnkey's published pricing is **per-signature**, not per-MAU. Wallet
creation is free. Tiers:

- Free: 100 wallets, 25 sigs/mo
- PAYG: $0.10/sig
- Pro: $99/mo + $0.05/sig
- Enterprise: as low as $0.0015/sig at high volume

For ENS at millions of accounts where many will be dormant, this is
the right shape. A user who signs up and never returns costs nothing.
A heavy user signing weekly costs cents per year at enterprise pricing.

If we batch through session keys on a Rhinestone SCA, the per-signature
cost drops further.

### 7. We built a wagmi connector — single source of truth in our app

The POC contains **`src/turnkey-connector.ts`**, a ~250-line custom
wagmi connector that wraps the Turnkey signer. After Turnkey login,
`useConnection()` returns the Turnkey address; `useSignMessage()`
routes through the Turnkey viem account; `useSendTransaction()` works
via the EIP-1193 shim. **One hook in the rest of the app, no dual
state.**

Important point: this is *our* connector, in *our* wagmi config. The
gating "vendor must not take over wagmi" requirement is unaffected —
Turnkey still ships no wagmi code; we wrote the shim ourselves and own
its evolution. The runtime assertion in `providers.tsx` continues to
pass.

This pattern is reusable for Web3Auth and (with caveats) Para. Worth
considering for the production architecture regardless of which
vendor wins.

---

## What to consider

These are real trade-offs, not deal-breakers. They need to be in the
team's eyes before committing.

### 0. New sub-orgs are EMPTY by default — Turnkey decouples auth from wallet, Para couples them

This is the single biggest UX-level difference between Turnkey and
Para and it deserves its own callout.

**Para's model:** one user = one MPC-shared key, created atomically at
signup. There is no "Para user without a wallet" state. The user
signs in via social auth and an address is immediately available.

**Turnkey's model:** a sub-organisation can have zero, one, or many
embedded wallets, plus connected external wallets. **Whether a wallet
is auto-created at signup depends on the Auth Proxy's "sub-org
template" setting in the Turnkey dashboard.** If that template
doesn't specify an Ethereum account, the sub-org comes up empty —
the user has a Turnkey identity but no address.

We hit this in the POC: after Google sign-in the user landed with
`tk.session` set but `tk.address === null`. The first workaround was
a manual "Create an embedded Ethereum wallet on this sub-org" button.
That's wrong UX for production.

**The production fix is two-layered:**

1. **In the Turnkey dashboard** — configure the Auth Proxy sub-org
   template to include `ADDRESS_FORMAT_ETHEREUM` accounts on every
   new sub-org. After this, social signups get a wallet automatically.
   (Note: existing sub-orgs are not backfilled when you change the
   template.)
2. **In our app's bridge hook** (`src/auth/useTurnkeyWagmiBridge.ts`)
   — defensively, we detect "session exists but no embedded wallet"
   and call `turnkey.createWallet({ accounts: ["ADDRESS_FORMAT_ETHEREUM"] })`
   ourselves before connecting wagmi. This makes Turnkey's UX match
   Para's: every social signup ends with the user having an address,
   no extra clicks. Wallet creation is free in Turnkey's pricing.

**Trade-off implications:**

- Turnkey's flexibility (sub-orgs can hold many wallets, can hold
  external wallets without an embedded one, etc.) is useful for
  some product shapes (e.g. a power user attaching their existing
  Ledger to their Turnkey identity). For ENS we don't need it — we
  want the Para-style "one user, one wallet, no configuration" UX.
- Reaching that UX on Turnkey takes one dashboard setting plus a
  defensive client-side check. Reaching Turnkey's flexibility on
  Para would require Para to fundamentally change its model.

**Conclusion:** Turnkey can be made to behave like Para here, but
out of the box it doesn't. Plan for it.

---

### 1. Several non-obvious dashboard gotchas

Setup is more involved than you'd expect from the docs. The ten
sharpest edges we hit, ranked by debugging cost:

1. **`turnkey.wallets[]` mixes embedded and connected wallets.** If
   you don't filter by `source === "embedded"`, you can grab a
   connected external wallet (e.g. a MetaMask attached via
   wallet-stamper) and try to sign with it via Turnkey's API. The
   server returns "Could not find any resource to sign with." Not
   documented.
2. **Sub-org template does NOT include a default wallet by default.**
   New sub-orgs come up with zero embedded wallets unless the Auth
   Proxy's template is explicitly configured to create one. We worked
   around it with a `createWallet` button; production should fix the
   template.
3. **OAuth setup requires three separate touches**, even though only
   one looks needed:
   - Toggle the provider in Social Logins.
   - Paste the Client ID into the per-provider field.
   - **Also** paste the Client ID into the "Social Linking → Google
     Whitelisted Client IDs" list. The UI labels it "Google" but it's
     a generic cross-provider whitelist. Without this, "Save Changes"
     stays disabled.
4. **X OAuth 2.0 is hidden in the X developer console.** The default
   credentials X shows are OAuth 1.0a (Consumer Key, Bearer Token).
   OAuth 2.0 lives under "User authentication settings → Set up" and
   the Client ID + Secret only appear once after configuration.
5. **`oauthRedirectUri` must match in three places exactly.** Trailing
   slash, scheme, host (`localhost` vs `127.0.0.1`) — one byte off and
   Google/X rejects with `redirect_uri_mismatch`. The places: Google
   Cloud Console / X developer portal, Turnkey dashboard's Social
   Logins → Redirect URL, and `TurnkeyProvider` config in code.
6. **Vite's default COOP breaks the OAuth popup.** Dev needs
   `Cross-Origin-Opener-Policy: unsafe-none` (or
   `same-origin-allow-popups`) to let the opener poll the popup's
   URL. We set this in `vite.config.ts`.
7. **The OAuth popup re-mounts the whole app by default.** We added a
   popup-detection guard in `src/main.tsx` so the popup renders a
   small "Completing sign-in…" placeholder instead of trying to consume
   the OAuth state itself.
8. **`@walletconnect/ethereum-provider` is a missing peer dep** of
   wagmi's `walletConnect()` connector. Not declared anywhere as a hard
   dep but required at runtime. Silent failure if missing.
9. **`isConnected` should not be gated on having a wallet address.**
   If you tie connection state to wallet presence, a sub-org with a
   delayed wallet creation appears "not signed in" and the login modal
   keeps refreshing.
10. **wagmi v3 deprecated aliases.** `useAccount`, `connect`,
    `disconnectAsync`, `signMessageAsync` are deprecated in favour of
    `useConnection`, `mutate`, `mutateAsync`. Same behaviour, just
    renamed.

None of these are blockers. All are documented in this POC and in the
README's "Integration gotchas" section. Together they cost ~half a
day of trial and error.

### 2. Bundle weight is moderate, but WalletConnect dominates

`npm run build` output:

```
dist/   5.3 MB total
  79 JS chunks
  1.6 MB largest single chunk
  1.0 MB brotli_wasm_bg.wasm   (WalletConnect / Reown WASM)
  660 KB nodecrypto polyfill
  336 KB lottie-react          (Turnkey's wallet-kit imports unconditionally)
```

Of this:

- **~700–800 KB is Turnkey** (`@turnkey/*` packages + Lottie animation
  runtime + stampers).
- **~3 MB is WalletConnect / Reown** (transitive of our `walletConnect()`
  wagmi connector). This isn't Turnkey's fault — but if we drop
  WalletConnect, total dist drops to ~2.3 MB.
- **`ethers@6` is installed as a runtime dep of `@turnkey/core`** but
  tree-shaken out of the final bundle. Watch this on upgrades — if
  Turnkey ever adds a top-level ethers import, it lands in the bundle.

Mitigations: pin Turnkey versions exactly, watch `bundle-report.html`
on every PR, consider lazy-loading `<TurnkeyProvider>` if first-paint
TTI becomes a problem.

### 3. Dual storage layer (Turnkey IndexedDB vs wagmi localStorage)

Turnkey persists session state in **IndexedDB**; wagmi persists the
last-used connector in **localStorage**. Each survives page reload via
its own mechanism. Clearing one does not clear the other.

The bridge hook (`useTurnkeyWagmiBridge`) reconciles these on sign-in
and sign-out. But if a user clears site data partially (e.g. clears
localStorage but not IndexedDB, or vice versa), the app can come up
in a weird half-state. Mitigation: provide an explicit "clear session"
button in production that flushes both.

### 4. X social login is its own sub-org unless emails align

By default, **X OAuth 2.0 does not include the user's email** in the
token. Turnkey's "Social Linking" feature links sub-orgs by email,
so the typical outcome is:

- Google sign-in + email OTP to the same address → **same sub-org,
  same key.**
- X sign-in → **separate sub-org, separate key** (different wallet).

To get X to share the same sub-org with Google/email, you have to:

1. In the X developer portal, request the `email` scope on the OAuth 2.0
   app.
2. Get the user to grant email access at consent time.
3. Ensure the user's X-registered email matches their Google email.

In practice, point 3 fails often (users have a Twitter-only email or a
work email on X but a personal Gmail). Plan UX around this: either tell
users which provider is "primary" or accept that some users will end
up with multiple wallets.

### 5. Account recovery if all auth methods are lost

If a user loses **all** of: email access + Google account + X account
+ all passkeys, they're locked out unless:

- They previously exported their key (then they have self-custody;
  Turnkey is irrelevant).
- Or we operate a backend that can call `DELETE_SUB_ORGANIZATION` /
  manual recovery activities with the parent-org API key. We can do
  this but it requires us to make and publish a recovery policy.

Compare with Para's vendor-managed recovery (vendor decides) and
Web3Auth's MPC-share-based recovery (depends on share custody design).
Turnkey's answer: **strong if the user exported their key; otherwise
the recovery answer is "ENS-as-parent-org has to decide."**

### 6. Auth Proxy is a hosted dependency

The Auth Proxy means we don't run a backend, but it does mean Turnkey
runs one for us. If their Auth Proxy is unavailable, **signup is
blocked** (existing users with active sessions are unaffected). The
fallback is to run `@turnkey/sdk-server` ourselves and stamp the
sub-org creation activities directly — operational cost, but a known
escape hatch.

### 7. Telegram is deferred and would carry ongoing backend cost

Turnkey does not ship Telegram as a built-in OAuth provider. The
brief (Q1) makes Telegram explicitly deferred. If/when it becomes
required, the implementation is:

1. Stand up a small backend endpoint that validates the Telegram Login
   Widget's signed payload against the bot token.
2. Mint an OIDC-shaped JWT with the validated identity.
3. Serve a JWKS endpoint with the JWT's public key.
4. Register that endpoint as a custom OIDC provider in Turnkey.

Doable but adds permanent backend ops surface. Same story applies to
Para and Web3Auth — none of them ship Telegram natively.

---

## Can the user take ownership of their private key?

**Yes — first-class, well-designed.** This is one of Turnkey's
strongest properties.

### How it works

`useTurnkey()` exposes `handleExportWallet`, `handleExportPrivateKey`,
and `handleExportWalletAccount`. Calling any of these opens a Turnkey
iframe (hosted at `export.turnkey.com`) inside our app. The flow:

```
┌──────────────────────────────────┐
│ User clicks "Export"             │
└─────────────────┬────────────────┘
                  ▼
┌──────────────────────────────────┐
│ Turnkey iframe loads in our app  │
│  - generates a P-256 Target      │
│    Encryption Key (TEK) locally  │
│  - sends TEK public key to the   │
│    parent (our app) via postMsg  │
└─────────────────┬────────────────┘
                  ▼
┌──────────────────────────────────┐
│ Our app submits an EXPORT_WALLET │
│ activity stamped with the user's │
│ session, including the TEK pubkey│
└─────────────────┬────────────────┘
                  ▼
┌──────────────────────────────────┐
│ Turnkey enclave HPKE-encrypts    │
│ the mnemonic to the TEK pubkey   │
│  - returns ciphertext            │
└─────────────────┬────────────────┘
                  ▼
┌──────────────────────────────────┐
│ Iframe decrypts ciphertext with  │
│ TEK private key (which never     │
│ leaves the iframe)               │
│  - displays mnemonic to the user │
└──────────────────────────────────┘
```

Properties:

- **Plaintext is visible only to the end user, inside the iframe.** Not
  our app, not Turnkey's operators.
- **HPKE encryption** (RFC 9180) — standard, audited.
- **The user gets the actual mnemonic or raw private key**, importable
  into MetaMask, Rabby, Ledger Live, etc.
- **After export, the user has self-custody.** Turnkey can disappear
  tomorrow and the user keeps their wallet.

### What it means for ENS

- If we ship an "Export your wallet" UI option, every user has a way
  out. ENS is then a thin orchestrator — losing Turnkey doesn't lose
  users their wallets.
- Even if we don't ship the UI immediately, the *capability* is there.
  We can ship it later or expose it as an API for advanced users.
- This aligns with ENS's identity-infrastructure positioning more than
  the vendor-managed-recovery model some other vendors push.

The POC does not yet wire an Export button in `AccountStatus.tsx`, but
adding one is one line — call `tk.handleExportWallet()` (or the
sub-variants for private-key or single-account export).

---

## Quick comparison heuristic (for the 3-way doc)

When `Social-Wallet/comparison.md` gets written, the row for Turnkey
should highlight:

| Dimension | Turnkey position |
|---|---|
| Wagmi takeover risk | **Cleanest** — zero wagmi code in the SDK |
| Headless mode | **Yes, by config flag** |
| Signer shape | **viem `LocalAccount`**, full interface |
| Key export | **First-class**, user-visible, iframe-based HPKE |
| Sub-org-per-user | **Yes**, via Auth Proxy, no backend needed |
| Wallet at signup | **Optional** (dashboard config or client-side auto-create); Para creates one automatically |
| Recovery policy | **We define it**; vendor doesn't impose one |
| Pricing shape | **Per-signature**, inactive users free |
| Backend required for POC | **No** (Auth Proxy holds parent key) |
| Bundle weight (excluding WC) | ~700–800 KB (moderate) |
| Built-in social providers | Google, Apple, Discord, X, Facebook |
| Telegram | Deferred — custom OIDC verifier |
| X same-key-as-Google | **No**, unless email scope + email match aligned |
| Dashboard UX | Several non-obvious gotchas (~half-day cost) |
| If vendor disappears | **User keeps wallet via exported mnemonic** |

---

## Recommendation shape (not the final call — that's the team's)

Based on the gating concern (wagmi non-takeover) and the second-order
concern (user self-custody), **Turnkey scores higher than Para on both
of the primary dimensions** the brief calls out:

- Para's wagmi decoupling depends on an undocumented internal gate;
  Turnkey's is the package default.
- Para's recovery is vendor-managed; Turnkey's is user-controlled
  via key export.

The trade-offs are operational (dashboard setup is finicky;
WalletConnect inflates the bundle) rather than architectural. None
of them block ENS's use case.

The remaining open question is whether **Web3Auth** beats Turnkey on
any dimension we care about. That's the next POC and the final
side-by-side.
