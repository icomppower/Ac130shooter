#!/usr/bin/env bash
#
# Everything that has to be true before this build is allowed to ship.
#
# The ladder is progressive: cheap structural checks first, then the type
# check and headless simulation, then the production build, then the browser
# kill gate. A failure stops the run, because a later gate's result is not
# meaningful once an earlier one is red.
#
#   ./verify.sh            full ladder
#   ./verify.sh --fast     skip the browser gate
set -uo pipefail
cd "$(dirname "$0")"

FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

pass=0
fail=0
step() {
  local name="$1"; shift
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m✔ %s\033[0m\n' "$name"; pass=$((pass + 1))
  else
    printf '\033[31m✖ %s\033[0m\n' "$name"; fail=$((fail + 1))
    printf '\n\033[31mStopping: later gates are not meaningful once this one is red.\033[0m\n'
    summary; exit 1
  fi
}
summary() { printf '\n%d passed, %d failed\n' "$pass" "$fail"; }

# ---------------------------------------------------------------------------
# V1  The simulation must not be able to see the renderer.
#
# The whole architecture rests on this one boundary, and it is the kind of
# thing that rots in a single careless import. Checked, not trusted.
# ---------------------------------------------------------------------------
check_sim_boundary() {
  local hits
  hits=$(grep -rnE "from '(three|\.\./(render|assets|ui|game)/)" src/sim || true)
  if [[ -n "$hits" ]]; then
    echo "src/sim reaches outside the simulation:"
    echo "$hits"
    return 1
  fi
  echo "src/sim imports nothing from three, render, assets, ui or game."
}

# ---------------------------------------------------------------------------
# V2  Every package used in code must be declared in package.json.
#
# This repo went from zero dependencies to carrying Three.js. A package that
# is imported but never declared works locally, because it is present as
# somebody else's transitive dependency, and then breaks the deploy build.
# That exact shape has bitten this account before.
# ---------------------------------------------------------------------------
check_manifest() {
  node --input-type=module -e '
    import {readFileSync, readdirSync, statSync} from "node:fs";
    import {join} from "node:path";
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const builtin = new Set(["node:fs", "node:path", "node:net", "node:url",
      "node:child_process", "node:fs/promises", "node:test", "node:assert",
      "node:assert/strict", "node:buffer", "node:process"]);
    const walk = d => readdirSync(d).flatMap(f => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const files = ["src", "tools", "tests", "gate"].flatMap(walk)
      .filter(f => /\.(ts|mjs|js)$/.test(f));
    const missing = new Map();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["\x27]([^"\x27]+)["\x27]/g)) {
        const spec = m[1];
        if (spec.startsWith(".") || spec.startsWith("/") || builtin.has(spec)) continue;
        // "three/addons/..." is served by the "three" package.
        const name = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        if (declared.has(name)) continue;
        if (!missing.has(name)) missing.set(name, file);
      }
    }
    if (missing.size) {
      console.error("imported but not declared in package.json:");
      for (const [name, file] of missing) console.error(`  ${name}  (first seen in ${file})`);
      process.exit(1);
    }
    console.log(`${files.length} files scanned; every imported package is declared.`);
  '
}

# ---------------------------------------------------------------------------
# V3  The shipped asset pack must be complete and loadable.
# ---------------------------------------------------------------------------
check_assets() {
  node --input-type=module -e '
    import {readFileSync, existsSync, statSync} from "node:fs";
    const manifest = JSON.parse(readFileSync("public/models/manifest.json", "utf8"));
    const missing = manifest.models.filter(n => !existsSync(`public/models/${n}.glb`));
    const empty = manifest.models.filter(n =>
      existsSync(`public/models/${n}.glb`) && statSync(`public/models/${n}.glb`).size < 512);
    if (missing.length || empty.length) {
      console.error("missing:", missing, "suspiciously small:", empty);
      process.exit(1);
    }
    console.log(`${manifest.models.length} models present in public/models/.`);
  '
}

# ---------------------------------------------------------------------------
# V4  GitHub Pages serves this repo from a subpath, so `base` has to be set.
#     Without it every built asset URL resolves to the domain root and 404s.
# ---------------------------------------------------------------------------
check_base_path() {
  grep -q "base: '/Ac130shooter/'" vite.config.ts || {
    echo "vite.config.ts must set base to the Pages subpath"; return 1;
  }
  echo "Pages base path is set."
}

step "V1  simulation/renderer boundary" check_sim_boundary
step "V2  dependency manifest complete" check_manifest
step "V3  asset pack present"           check_assets
step "V4  Pages base path"              check_base_path
step "V5  type check"                   npx tsc --noEmit
step "V6  headless simulation tests"    npm test --silent
step "V7  production build"             npm run build --silent

if [[ $FAST -eq 1 ]]; then
  printf '\n\033[33mSkipping the browser kill gate (--fast).\033[0m\n'
  summary
  exit 0
fi

step "V8  browser kill gate"            npm run gate --silent
summary
