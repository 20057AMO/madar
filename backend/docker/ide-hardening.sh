#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Madar — VS Code (code-server) image hardening: the SINGLE enforcement point.
#
# Why this exists as a script and not as Dockerfile lines: `dpkg -i` restores the
# pristine /usr/lib/code-server. code-server-update.ts (interactive update) and
# updates-boot.ts (boot re-apply) both run it at runtime, so anything that is not
# re-applied after a dpkg install silently resurrects the whole Copilot payload
# (127 MB of native binaries under @github alone) and the ~270 MB RAM sidecar it
# spawns on every boot. One script, called from the image build, from every dpkg
# call site and from the boot sync, is the only shape that stays correct across a
# version bump.
#
# Modes
#   capture  Snapshot the computed restore closure into /opt/madar/ide-builtin.
#            Image build only, while the pristine tree is intact, BEFORE the deb
#            is deleted — the closure can only be computed from the UNSLIMMED
#            tree, and dpkg has already discarded the deb by the time anything
#            runs at runtime. The Dockerfile asserts the captured dir is
#            populated, because a capture that silently no-oped (absent tree)
#            would otherwise reach `verify`, which no-ops on the same condition,
#            and a broken image would build green.
#   apply    Restore that closure, re-apply the keep-list slimming, write the
#            @github Copilot stubs. Idempotent.
#   verify   Assert every invariant; exit 1 with a precise message on violation.
#
# The closure is COMPUTED, not named. vscode.git declares
# extensionDependencies:["vscode.git-base"], so a name-based delete-list silently
# deleted the Git extension's only dependency and Source Control died at
# "Scanning folder for Git repositories..." forever. Starting from the keep-list
# roots and walking extensionDependencies transitively means a future built-in
# that declares a new dependency restores it without anyone editing a list.
#
# TREE-ABSENT CONTRACT (deliberate, load-bearing): component-updates.test.ts
# builds fake code-server debs whose payload is a single `version` file, so a
# legitimate `dpkg -i` WIPES /usr/lib/code-server. An absent extensions tree is
# therefore a GRACEFUL NO-OP (exit 0, no writes) in every mode — only a tree that
# is PRESENT but violates an invariant fails. Hardening must never be able to
# break an update flow or a boot on an install that does not carry this layer.
#
# No `set -e`: every step is explicitly guarded so verify can report exactly which
# invariant broke instead of dying on the first non-zero exit.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

CS_ROOT="${WSD_CODE_SERVER_ROOT:-/usr/lib/code-server}"
EXT_DIR="$CS_ROOT/lib/vscode/extensions"
GITHUB_DIR="$CS_ROOT/lib/vscode/node_modules/@github"
SAVED_DIR="${WSD_IDE_BUILTIN_DIR:-/opt/madar/ide-builtin}"

# Built-in extension ids (publisher.name) Madar keeps. A KEEP-list, not a
# delete-list: the old rm list used unprefixed dir names that did not match the
# real ones (ms-vscode.js-debug-companion, ms-vscode.vscode-js-profile-table),
# so two dirs silently survived every build. Anything not listed here is pruned,
# which is what makes the layer version-bump-safe: a renamed or new built-in is
# removed without anyone naming it, and nothing is removed by a stale name.
KEEP_LIST='vscode.cpp
vscode.css-language-features
vscode.css
vscode.docker
vscode.emmet
vscode.git
vscode.handlebars
vscode.html-language-features
vscode.html
vscode.javascript
vscode.json-language-features
vscode.json
vscode.less
vscode.log
vscode.make
vscode.markdown
vscode.markdown-language-features
vscode.markdown-math
vscode.merge-conflict
ms-vscode.js-debug
vscode.builtin-notebook-renderers
vscode.npm
vscode.php-language-features
vscode.python
vscode.references-view
vscode.scss
vscode.shellscript
vscode.sql
vscode.terminal-suggest
vscode.theme-defaults
vscode.vscode-modern-icons
vscode.vscode-theme-seti
vscode.typescript
vscode.typescript-language-features
vscode.xml
vscode.yaml'

# I5 band. Wide on purpose: it guards a CATASTROPHIC prune (a keep-list that no
# longer matches the tree, an apply against the wrong root), not a single rename.
MIN_BUILTIN_DIRS="${WSD_IDE_MIN_BUILTIN_DIRS:-30}"
MAX_BUILTIN_DIRS="${WSD_IDE_MAX_BUILTIN_DIRS:-50}"

ELF_MAGIC=$(printf '\177ELF')
MODE="${1:-verify}"

log() { printf 'ide-hardening[%s]: %s\n' "$MODE" "$*"; }
fail() { printf 'ide-hardening[%s]: %s\n' "$MODE" "$*" >&2; exit 1; }
tree_present() { [ -d "$EXT_DIR" ]; }
dir_bytes() { du -sb "$1" 2>/dev/null | cut -f1; }
in_list() { local n="$1"; shift; local x; for x in "$@"; do [ "$x" = "$n" ] && return 0; done; return 1; }
keep_ids() { local l; while IFS= read -r l; do [ -n "$l" ] && printf '%s\n' "$l"; done <<< "$KEEP_LIST"; }

# id<TAB>dir for every built-in dir that carries a package.json (the directory
# IS the manifest for built-ins — there is no extensions.json).
builtin_map() {
  local d id
  for d in "$EXT_DIR"/*/; do
    [ -f "$d/package.json" ] || continue
    id=$(jq -r '(.publisher // "?") + "." + (.name // "?")' "$d/package.json" 2>/dev/null)
    [ -n "$id" ] && [ "$id" != "null" ] && printf '%s\t%s\n' "$id" "${d%/}"
  done
  return 0
}

map_dir() { awk -F'\t' -v id="$1" '$1 == id { print $2; exit }'; }
map_has() { awk -F'\t' -v id="$1" '$1 == id { found = 1 } END { exit !found }'; }

saved_ids() {
  local d id
  [ -d "$SAVED_DIR" ] || return 0
  for d in "$SAVED_DIR"/*/; do
    [ -f "$d/package.json" ] || continue
    id=$(jq -r '(.publisher // "?") + "." + (.name // "?")' "$d/package.json" 2>/dev/null)
    [ -n "$id" ] && [ "$id" != "null" ] && printf '%s\n' "$id"
  done
  return 0
}

# ── capture ────────────────────────────────────────────────────────────────
cmd_capture() {
  tree_present || { log "extensions tree absent ($EXT_DIR) — nothing to capture"; return 0; }
  command -v jq >/dev/null 2>&1 || fail "jq is required to compute the extension map"

  local map; map=$(builtin_map)
  [ -n "$map" ] || fail "no built-in extension found under $EXT_DIR — refusing to capture an empty closure"

  # Roots: every keep-list id present in the pristine tree. Walking from ALL of
  # them (not just vscode.git) means any kept extension's own
  # extensionDependencies are captured too, so the closure cannot fall behind a
  # future built-in.
  local -a roots=() queue=() seen=() ids=()
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    printf '%s\n' "$map" | map_has "$id" && roots+=("$id")
  done < <(keep_ids)

  [ "${#roots[@]}" -gt 0 ] || fail "no keep-list extension resolved in the pristine tree (map has $(printf '%s\n' "$map" | wc -l) dirs) — the keep list does not match this code-server version"

  queue=("${roots[@]}")
  while [ "${#queue[@]}" -gt 0 ]; do
    id="${queue[0]}"
    queue=("${queue[@]:1}")
    in_list "$id" "${seen[@]+"${seen[@]}"}" && continue
    seen+=("$id")
    local resolved deps dep
    resolved=$(printf '%s\n' "$map" | map_dir "$id")
    [ -n "$resolved" ] || continue
    deps=$(jq -r '(.extensionDependencies // [])[]?' "$resolved/package.json" 2>/dev/null)
    while IFS= read -r dep; do
      [ -n "$dep" ] && queue+=("$dep")
    done <<< "$deps"
  done
  ids=("${seen[@]}")

  rm -rf "$SAVED_DIR"
  mkdir -p "$SAVED_DIR" || fail "cannot create $SAVED_DIR"
  local copied=0
  for id in "${ids[@]}"; do
    local src; src=$(printf '%s\n' "$map" | map_dir "$id")
    if [ -n "$src" ] && [ -d "$src" ]; then
      cp -a "$src" "$SAVED_DIR/$(basename "$src")" || fail "failed to save the closure member $id"
      copied=$((copied + 1))
    else
      log "warning: closure member $id does not resolve in the pristine tree — not saved"
    fi
  done
  log "captured the restore closure ($copied dirs, ${#ids[@]} ids): ${ids[*]}"
}

# ── @github stubs ──────────────────────────────────────────────────────────
# VS Code 1.138's prebuilt agentHost STATICALLY imports @github/copilot and
# @github/copilot-sdk, so deleting the whole tree logs a fatal
# ERR_MODULE_NOT_FOUND at every boot. Every package under @github is therefore
# REPLACED by a stub (rm -rf + recreate, so no leftover dist bundles survive),
# and the flavour is chosen structurally from each package.json rather than from
# its name: a package that declares `bin` is SPAWNED as an executable, so its
# stub exits 0; everything else is imported, so its stub exports {}.
#
# Name-based stubbing was tried first and was wrong: code-server 4.138 ships a
# FOURTH package, @github/copilot-sdk-linux-x64 (127 MB of native payload) that
# the named list never touched — 442 MB of /usr/lib/code-server instead of the
# intended ~330 MB, while every named check still passed green. Stubbing the
# whole tree is what makes this survive the next package rename.
# `spawned` when the package declares `bin` (it is executed, so the stub must
# exit 0 immediately), `imported` otherwise (the stub must export {}).
# SINGLE definition, shared by the writer and the checker below: as two
# hand-written jq expressions they disagreed on a package with no `bin` field at
# all — the writer emitted an import stub while the checker demanded an exit
# stub, and the build failed on its own invariant. The writer and the checker
# must never be allowed to define "what a correct stub is" separately.
github_stub_kind() {
  jq -r 'if has("bin") and (.bin != null) then "spawned" else "imported" end' "$1" 2>/dev/null \
    || echo "imported"
}

# Every bin name of a `spawned` package points at the same exit-0 index.js.
# Only valid when github_stub_kind said `spawned`.
github_stub_bin_json() {
  jq -c 'if (.bin | type) == "string" then {(.bin): "index.js"} else (.bin | with_entries(.value = "index.js")) end' "$1" 2>/dev/null
}

write_github_stubs() {
  mkdir -p "$GITHUB_DIR" || { log "warning: cannot create $GITHUB_DIR"; return 1; }

  local pkg name kind bin_json
  for pkg in "$GITHUB_DIR"/*/; do
    [ -d "$pkg" ] || continue
    name=$(jq -r '.name // empty' "$pkg/package.json" 2>/dev/null)
    [ -n "$name" ] || name="$(basename "$pkg")"
    kind=$(github_stub_kind "$pkg/package.json")
    # Read the REAL bin map before the package.json is replaced: the command
    # name VS Code spawns by is whatever this declares (copilot-linux-x64 says
    # `github-copilot`, not `@github/copilot-linux-x64`), and a stub published
    # under a synthesised name leaves the original entry dangling.
    [ "$kind" = "spawned" ] && bin_json=$(github_stub_bin_json "$pkg/package.json")
    rm -rf "$pkg" || { log "warning: could not replace the @github package $name"; continue; }
    mkdir -p "$pkg" || { log "warning: could not recreate the @github package $name"; continue; }
    if [ "$kind" = "spawned" ]; then
      printf '{"name":"%s","version":"0.0.0","main":"index.js","bin":%s}\n' "$name" "$bin_json" > "$pkg/package.json"
      printf '#!/usr/bin/env node\nprocess.exit(0)\n' > "$pkg/index.js"
      chmod +x "$pkg/index.js"
      log "stubbed the spawned @github package $name (bin $(jq -r '.bin | if type == "string" then . else keys | join(",") end' "$pkg/package.json"))"
    else
      printf '{"name":"%s","version":"0.0.0","main":"index.js"}\n' "$name" > "$pkg/package.json"
      printf 'module.exports={}\n' > "$pkg/index.js"
      log "stubbed the imported @github package $name"
    fi
  done
  return 0
}

# ── apply ──────────────────────────────────────────────────────────────────
cmd_apply() {
  tree_present || { log "extensions tree absent ($EXT_DIR) — skipping (tree-absent contract)"; return 0; }

  local d base id restored=0 pruned=0
  if [ -d "$SAVED_DIR" ]; then
    for d in "$SAVED_DIR"/*/; do
      [ -d "$d" ] || continue
      base=$(basename "$d")
      [ -f "$EXT_DIR/$base/package.json" ] && continue
      if cp -a "$d" "$EXT_DIR/$base" 2>/dev/null; then
        restored=$((restored + 1))
      else
        log "warning: could not restore the closure member $base"
      fi
    done
  else
    log "warning: no captured closure at $SAVED_DIR — only the keep-list is enforced"
  fi

  local map; map=$(builtin_map)
  local -a kept=() restored_ids=()
  while IFS= read -r id; do [ -n "$id" ] && kept+=("$id"); done < <(keep_ids)
  while IFS= read -r id; do [ -n "$id" ] && restored_ids+=("$id"); done < <(saved_ids)
  while IFS=$'\t' read -r id d; do
    [ -n "$id" ] || continue
    in_list "$id" "${kept[@]+"${kept[@]}"}" && continue
    in_list "$id" "${restored_ids[@]+"${restored_ids[@]}"}" && continue
    if rm -rf "$d" 2>/dev/null; then pruned=$((pruned + 1)); fi
  done <<< "$map"

  write_github_stubs || log "warning: the @github stubs could not be written"

  log "apply OK — closure restored: $restored, pruned: $pruned, built-in dirs: $(builtin_map | wc -l)"
}

# ── verify ─────────────────────────────────────────────────────────────────
check_i1_copilot_absent() {
  [ -d "$EXT_DIR/copilot" ] && fail "I1: $EXT_DIR/copilot exists — the Copilot extension directory is back"
  return 0
}

check_i2_sidecar_stubbed() {
  # Tree-wide, NOT per package name: `find` for the ELF magic is the property
  # that matters (a spawned binary is an ELF, whatever the package is called),
  # and the total-size ceiling is what catches a package the named list missed.
  [ -d "$GITHUB_DIR" ] || fail "I2: $GITHUB_DIR is missing — @github must be stubbed, never simply deleted (agentHost imports it)"
  local elf total
  elf=$(find "$GITHUB_DIR" -type f -exec grep -lFa -- "$ELF_MAGIC" {} + 2>/dev/null | head -3)
  [ -z "$elf" ] || fail "I2: an ELF executable is present under $GITHUB_DIR ($elf) — a real Copilot binary payload is back"
  total=$(dir_bytes "$GITHUB_DIR")
  [ -n "$total" ] || fail "I2: cannot measure $GITHUB_DIR"
  [ "$total" -lt 2097152 ] || fail "I2: $GITHUB_DIR is $total bytes (>= 2 MiB) — a real Copilot payload survived (a package outside the named set?)"
  local pkg name kind bytes
  for pkg in "$GITHUB_DIR"/*/; do
    [ -d "$pkg" ] || continue
    [ -f "$pkg/package.json" ] || fail "I2: $(basename "$pkg") has no package.json — an import of it would fail"
    name=$(jq -r '.name // empty' "$pkg/package.json" 2>/dev/null)
    [ -n "$name" ] || fail "I2: $(basename "$pkg")/package.json declares no name"
    [ "$(github_stub_kind "$pkg/package.json")" = "spawned" ] || continue
    # A package with a `bin` is SPAWNED: a stub that ran real work (or hung)
    # would be worse than one that exits immediately.
    bytes=$(dir_bytes "$pkg")
    { [ -n "$bytes" ] && [ "$bytes" -lt 1048576 ]; } \
      || fail "I2: the spawned package $name is ${bytes:-unmeasurable} bytes (>= 1 MiB) — the real sidecar payload is back"
    grep -qF 'process.exit(0)' "$pkg/index.js" 2>/dev/null \
      || fail "I2: $name/index.js does not exit 0 — a forced spawn would actually run"
  done
  return 0
}

check_i3_js_stubs() {
  # Every @github package that is IMPORTED rather than spawned must be an empty
  # export: agentHost's static `import '@github/copilot'` resolves this, and a
  # 753 KB dist bundle surviving here is both dead weight and a sign the
  # replace-in-place approach came back (the old Dockerfile overwrote index.js
  # without removing the rest of the directory).
  local pkg name kind bytes imported=0
  [ -d "$GITHUB_DIR" ] || fail "I3: $GITHUB_DIR is missing — agentHost dies with ERR_MODULE_NOT_FOUND"
  for pkg in "$GITHUB_DIR"/*/; do
    [ -d "$pkg" ] || continue
    [ "$(github_stub_kind "$pkg/package.json" 2>/dev/null)" = "imported" ] || continue
    name=$(jq -r '.name // empty' "$pkg/package.json" 2>/dev/null)
    [ -n "$name" ] || name="$(basename "$pkg")"
    imported=$((imported + 1))
    bytes=$(dir_bytes "$pkg")
    [ -n "$bytes" ] || fail "I3: cannot measure $GITHUB_DIR/$name"
    [ "$bytes" -lt 65536 ] || fail "I3: the imported package $name is $bytes bytes (>= 64 KiB) — the real SDK payload is back"
    grep -qF 'module.exports={}' "$pkg/index.js" 2>/dev/null \
      || fail "I3: $name/index.js does not export an empty object"
  done
  [ "$imported" -gt 0 ] \
    || fail "I3: no imported @github package found under $GITHUB_DIR — the tree was emptied instead of stubbed (agentHost would log ERR_MODULE_NOT_FOUND)"
  return 0
}

check_i4_dependencies_resolve() {
  # The captured closure is a VERIFY precondition, not just an apply input: it
  # lives in /opt/madar, which no dpkg install ever touches, so losing it means
  # a broken image. Verifying without it would let a build ship an image whose
  # next dpkg upgrade cannot restore vscode.git-base at all.
  if [ ! -d "$SAVED_DIR" ] || [ -z "$(saved_ids)" ]; then
    fail "I4: no captured restore closure at $SAVED_DIR — a dpkg install could not restore vscode.git-base"
  fi
  local map; map=$(builtin_map)
  [ -n "$map" ] || fail "I4: no built-in extension found under $EXT_DIR"
  local -a kept=() queue=() seen=()
  local id resolved deps dep
  while IFS= read -r id; do [ -n "$id" ] && kept+=("$id"); done < <(keep_ids)
  queue=("${kept[@]}")
  while [ "${#queue[@]}" -gt 0 ]; do
    id="${queue[0]}"
    queue=("${queue[@]:1}")
    in_list "$id" "${seen[@]+"${seen[@]}"}" && continue
    seen+=("$id")
    resolved=$(printf '%s\n' "$map" | map_dir "$id")
    if [ -z "$resolved" ]; then
      in_list "$id" "${kept[@]+"${kept[@]}"}" \
        && fail "I4: keep-list extension $id is missing from $EXT_DIR"
      continue
    fi
    deps=$(jq -r '(.extensionDependencies // [])[]?' "$resolved/package.json" 2>/dev/null)
    while IFS= read -r dep; do
      [ -n "$dep" ] || continue
      printf '%s\n' "$map" | map_has "$dep" \
        || fail "I4: $id depends on $dep, which is not present in $EXT_DIR — the extension cannot activate (Source Control hangs on \"Scanning folder for Git repositories...\")"
      queue+=("$dep")
    done <<< "$deps"
  done
  return 0
}

check_i5_dir_count() {
  local n; n=$(builtin_map | wc -l)
  [ "$n" -ge "$MIN_BUILTIN_DIRS" ] \
    || fail "I5: only $n built-in extension dirs are present (expected >= $MIN_BUILTIN_DIRS) — a prune went wrong"
  [ "$n" -le "$MAX_BUILTIN_DIRS" ] \
    || fail "I5: $n built-in extension dirs are present (expected <= $MAX_BUILTIN_DIRS) — the keep-list prune did not run"
  return 0
}

cmd_verify() {
  tree_present || { log "extensions tree absent ($EXT_DIR) — nothing to verify (tree-absent contract)"; return 0; }
  check_i1_copilot_absent
  check_i2_sidecar_stubbed
  check_i3_js_stubs
  check_i4_dependencies_resolve
  check_i5_dir_count
  log "verify OK — built-in dirs: $(builtin_map | wc -l), closure: $(saved_ids | tr '\n' ' ')"
}

case "$MODE" in
  capture) cmd_capture ;;
  apply) cmd_apply ;;
  verify) cmd_verify ;;
  *) fail "usage: ide-hardening.sh [capture|apply|verify] (got '${MODE}')" ;;
esac
