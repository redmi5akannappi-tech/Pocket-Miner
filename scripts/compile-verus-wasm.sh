#!/usr/bin/env bash
# =============================================================================
# compile-verus-wasm.sh
#
# Compiles VerusHash 2.1 to WebAssembly using Emscripten.
# Run this on Linux or WSL (Windows Subsystem for Linux).
#
# Prerequisites:
#   - WSL (Ubuntu) or a Linux machine
#   - git, cmake, python3
#   - Emscripten SDK (installed by this script if missing)
#
# Usage (from the Pocket Miner root, in WSL):
#   bash scripts/compile-verus-wasm.sh
#
# Output:
#   client/public/wasm/verus_hash.wasm
#   client/public/wasm/verus_hash.js   (glue code — NOT used, we use raw WASM)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build"
WASM_OUT="$ROOT_DIR/client/public/wasm"
EMSDK_DIR="$HOME/emsdk"

echo "=============================================="
echo " Pocket Miner — VerusHash → WASM Compiler"
echo "=============================================="
echo ""

# ─── Step 1: Install Emscripten SDK ───────────────────────────────────────────
if ! command -v emcc &>/dev/null; then
  echo "[1/5] Installing Emscripten SDK..."
  if [ ! -d "$EMSDK_DIR" ]; then
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
  fi
  cd "$EMSDK_DIR"
  ./emsdk install latest
  ./emsdk activate latest
  source "$EMSDK_DIR/emsdk_env.sh"
  cd "$SCRIPT_DIR"
else
  echo "[1/5] Emscripten already installed: $(emcc --version | head -1)"
  # Make sure emsdk env is loaded
  if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    source "$EMSDK_DIR/emsdk_env.sh" 2>/dev/null || true
  fi
fi

# ─── Step 2: Clone VerusCoin source ───────────────────────────────────────────
echo "[2/5] Fetching VerusCoin source (sparse clone)..."
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

if [ ! -d "VerusCoin" ]; then
  git clone --depth=1 --filter=blob:none --sparse \
    https://github.com/VerusCoin/VerusCoin.git VerusCoin
  cd VerusCoin
  # Only pull the crypto directory we need
  git sparse-checkout set src/crypto
  cd "$BUILD_DIR"
else
  echo "  (already cloned, skipping)"
fi

CRYPTO_SRC="$BUILD_DIR/VerusCoin/src/crypto"

# ─── Step 3: Collect source files ─────────────────────────────────────────────
echo "[3/5] Collecting VerusHash source files..."

# Copy the wrapper into build dir alongside the crypto sources
cp "$SCRIPT_DIR/verus_wrapper.c" "$BUILD_DIR/"

# List all .cpp and .c files we need
SOURCES=(
  "$BUILD_DIR/verus_wrapper.c"
  "$CRYPTO_SRC/verushash/verushash.cpp"
  "$CRYPTO_SRC/haraka.c"
  "$CRYPTO_SRC/sha256.cpp"
)

# Filter out any that don't exist (repo structure varies by version)
EXISTING_SOURCES=()
for f in "${SOURCES[@]}"; do
  if [ -f "$f" ]; then
    EXISTING_SOURCES+=("$f")
    echo "  + $f"
  else
    echo "  - MISSING: $f (skipping)"
  fi
done

# Also grab any .cpp in verushash subdirectory
if [ -d "$CRYPTO_SRC/verushash" ]; then
  while IFS= read -r -d '' f; do
    # Avoid duplicates
    if [[ ! " ${EXISTING_SOURCES[*]} " =~ " $f " ]]; then
      EXISTING_SOURCES+=("$f")
      echo "  + $f"
    fi
  done < <(find "$CRYPTO_SRC/verushash" -name "*.cpp" -print0)
fi

# ─── Step 4: Compile to WASM ──────────────────────────────────────────────────
echo "[4/5] Compiling to WebAssembly..."
mkdir -p "$WASM_OUT"

INCLUDE_DIRS=(
  "-I$CRYPTO_SRC"
  "-I$CRYPTO_SRC/verushash"
  "-I$BUILD_DIR/VerusCoin/src"
)

emcc "${EXISTING_SOURCES[@]}" \
  "${INCLUDE_DIRS[@]}" \
  -o "$WASM_OUT/verus_hash.js" \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_verus_hash","_alloc","_dealloc","_meets_difficulty"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s MODULARIZE=0 \
  -s ENVIRONMENT='web,worker' \
  -s NO_EXIT_RUNTIME=1 \
  -O3 \
  --no-entry \
  -fno-rtti \
  -DHAVE_CONFIG_H \
  2>&1

# ─── Step 5: Verify output ────────────────────────────────────────────────────
echo "[5/5] Verifying output..."
if [ -f "$WASM_OUT/verus_hash.wasm" ]; then
  SIZE=$(du -sh "$WASM_OUT/verus_hash.wasm" | cut -f1)
  echo ""
  echo "✅  SUCCESS!"
  echo "   Output: client/public/wasm/verus_hash.wasm ($SIZE)"
  echo "   Output: client/public/wasm/verus_hash.js"
  echo ""
  echo "  Next step: restart the frontend dev server."
  echo "  The miner.worker.js will auto-detect the WASM file."
else
  echo ""
  echo "❌  WASM file not created. Check errors above."
  echo "   Common fixes:"
  echo "   - Make sure emcc is in PATH (run: source ~/emsdk/emsdk_env.sh)"
  echo "   - Check that VerusCoin source cloned correctly"
  exit 1
fi
