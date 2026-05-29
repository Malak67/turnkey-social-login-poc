#!/usr/bin/env node
/**
 * Scans node_modules for any package that imports `WagmiProvider` or calls
 * `createConfig` from `wagmi`. We need to prove that the Turnkey SDK does
 * NOT bring its own wagmi provider — Para does (see the Para POC's Risk 1).
 *
 * Run: npm run audit:wagmi-providers
 * Exit code: 0 if only `wagmi` itself owns those symbols, non-zero on hits
 * inside a vendor package.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../node_modules", import.meta.url).pathname;
const NEEDLES = [/from\s+["']wagmi["']/, /WagmiProvider/];
const VENDOR_PREFIXES = ["@turnkey", "@rhinestone", "@reown", "@walletconnect"];

let problems = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(m?js|cjs|ts|tsx)$/.test(name)) continue;
    // Skip type files
    if (name.endsWith(".d.ts")) continue;
    let body;
    try {
      body = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const re of NEEDLES) {
      if (re.test(body)) {
        console.log(`  hit: ${full.replace(ROOT, "node_modules")}  (${re})`);
        problems++;
        break;
      }
    }
  }
}

for (const prefix of VENDOR_PREFIXES) {
  const dir = join(ROOT, prefix);
  try {
    statSync(dir);
  } catch {
    continue;
  }
  console.log(`\nscanning ${prefix}/...`);
  walk(dir);
}

console.log("");
if (problems === 0) {
  console.log("✓ no WagmiProvider / wagmi imports in vendor packages");
  process.exit(0);
} else {
  console.error(`✗ ${problems} match(es) — investigate before proceeding`);
  process.exit(1);
}
