import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { Providers } from "./providers.tsx";

/**
 * Detect "I am the OAuth popup that just got redirected back from
 * Google with the state in the URL fragment." In that case we render
 * NOTHING — the OAuth state belongs to the opener tab, which is
 * polling `authWindow.location.href` and will close us as soon as it
 * sees the fragment. If we mount the full app + TurnkeyProvider here,
 * the popup tries to consume the OAuth state itself, fails (the PKCE
 * verifier lives in the opener's storage), and the popup gets stuck
 * showing our regular UI.
 */
const isOauthPopup =
  typeof window !== "undefined" &&
  window.opener &&
  window.opener !== window &&
  (window.location.hash.includes("state=") ||
    window.location.search.includes("state="));

if (isOauthPopup) {
  createRoot(document.getElementById("root")!).render(
    <div
      style={{
        font: "14px system-ui",
        padding: "2rem",
        textAlign: "center",
        color: "#6b7280",
      }}
    >
      Completing sign-in…
    </div>,
  );
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Providers>
        <App />
      </Providers>
    </StrictMode>,
  );
}
