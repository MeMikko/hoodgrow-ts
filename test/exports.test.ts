import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Every public response type must be re-exported from the barrel.
 *
 * `getMarkets()` and `getTrades()` shipped for several releases returning
 * `MarketsResponse`, `MarketToken`, `Trade`, `TradesResponse` and `TradeSide` —
 * all defined in types.ts, none re-exported from index.ts. Because the package
 * `exports` map only exposes ".", a deep import could not reach them either, so
 * a TypeScript consumer had no way to name the return type of two public
 * methods.
 *
 * Asserting the whole set rather than those five names is deliberate: the bug
 * was drift between two files, and only a check that covers every type stops
 * the next one appearing the same way.
 */

const src = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

function declaredTypes(source: string): string[] {
  return [...source.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]!);
}

function barrelTypeExports(source: string): Set<string> {
  const names = new Set<string>();
  // Every `export type { … } from "./types.js"` block in the barrel.
  for (const block of source.matchAll(/export type \{([^}]*)\} from "\.\/types\.js"/g)) {
    for (const raw of block[1]!.split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

test("every type declared in types.ts is re-exported from index.ts", async () => {
  const [types, barrel] = await Promise.all([
    readFile(src("types.ts"), "utf8"),
    readFile(src("index.ts"), "utf8"),
  ]);

  const declared = declaredTypes(types);
  assert.ok(declared.length > 0, "expected to find exported types in types.ts");

  const exported = barrelTypeExports(barrel);
  const missing = declared.filter((name) => !exported.has(name));

  assert.deepEqual(
    missing,
    [],
    `types.ts declares types the barrel does not re-export, so consumers cannot name them: ${missing.join(", ")}`,
  );
});

test("the barrel does not re-export a type that no longer exists", async () => {
  const [types, barrel] = await Promise.all([
    readFile(src("types.ts"), "utf8"),
    readFile(src("index.ts"), "utf8"),
  ]);

  const declared = new Set(declaredTypes(types));
  const stale = [...barrelTypeExports(barrel)].filter((name) => !declared.has(name));

  assert.deepEqual(stale, [], `index.ts re-exports types that types.ts no longer declares: ${stale.join(", ")}`);
});
