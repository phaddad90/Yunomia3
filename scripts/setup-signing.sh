#!/usr/bin/env bash
# Yunomia signing & updater key setup.
#
# Run this once on the maintainer machine to:
#   1. Generate a Tauri updater keypair (for signed in-app updates).
#   2. Push every required GitHub secret to phaddad90/Yunomia3.
#
# Prereqs:
#   - gh CLI authenticated  (gh auth status)
#   - npm + npx installed  (for tauri signer generate)
#   - An Apple Developer ID Application cert exported as cert.p12 in $PWD,
#     OR you'll be prompted to paste paths.
#   - An Apple ID + app-specific password (https://appleid.apple.com/account/manage)
#   - Apple Team ID (10-char alphanumeric)
#
# Usage:
#   bash scripts/setup-signing.sh

set -euo pipefail

REPO="phaddad90/Yunomia3"
UPDATER_KEY_DIR="$HOME/.yunomia-keys"
UPDATER_PRIV="$UPDATER_KEY_DIR/yunomia-updater.key"
UPDATER_PUB="$UPDATER_KEY_DIR/yunomia-updater.key.pub"

mkdir -p "$UPDATER_KEY_DIR"

# --- Step 1: Tauri updater keypair ----------------------------------------

if [ ! -f "$UPDATER_PRIV" ]; then
  echo "==> Generating Tauri updater keypair (kept locally at $UPDATER_PRIV)"
  npx --yes @tauri-apps/cli signer generate --write-keys "$UPDATER_PRIV" --no-password
else
  echo "==> Updater keypair already exists at $UPDATER_PRIV (re-using)"
fi

PUBKEY=$(cat "$UPDATER_PUB")
echo "==> Public key (paste into src-tauri/tauri.conf.json plugins.updater.pubkey):"
echo
echo "$PUBKEY"
echo

read -rp "Patch tauri.conf.json with this pubkey now? [y/N] " yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
  CONF="src-tauri/tauri.conf.json"
  if [ ! -f "$CONF" ]; then
    echo "tauri.conf.json not found - run from repo root."; exit 1
  fi
  # Replace the placeholder pubkey line.
  python3 -c "
import json, sys
p = '$CONF'
with open(p) as f: c = json.load(f)
c.setdefault('plugins', {}).setdefault('updater', {})['pubkey'] = '$PUBKEY'
with open(p, 'w') as f: json.dump(c, f, indent=2)
print('updated', p)
"
fi

# --- Step 2: GitHub secrets -----------------------------------------------

echo
echo "==> Pushing updater private key to GitHub secrets"
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$REPO" --body "$(cat $UPDATER_PRIV)"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$REPO" --body ""

echo
echo "==> Apple Developer signing"
read -rp "Path to your Developer ID .p12 cert: " P12_PATH
read -rsp "Cert password: " P12_PASS; echo
read -rp "Apple Signing Identity (e.g. 'Developer ID Application: Peter Haddad (TEAMID)'): " APPLE_IDENTITY
read -rp "Apple ID email: " APPLE_ID
read -rsp "Apple app-specific password: " APPLE_PASSWORD; echo
read -rp "Apple Team ID (10-char): " APPLE_TEAM_ID

gh secret set APPLE_CERTIFICATE          --repo "$REPO" --body "$(base64 < "$P12_PATH")"
gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$REPO" --body "$P12_PASS"
gh secret set APPLE_SIGNING_IDENTITY     --repo "$REPO" --body "$APPLE_IDENTITY"
gh secret set APPLE_ID                   --repo "$REPO" --body "$APPLE_ID"
gh secret set APPLE_PASSWORD             --repo "$REPO" --body "$APPLE_PASSWORD"
gh secret set APPLE_TEAM_ID              --repo "$REPO" --body "$APPLE_TEAM_ID"

echo
read -rp "Set up Windows code-signing too? [y/N] " yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
  read -rp "Path to your Windows .pfx cert: " PFX_PATH
  read -rsp "PFX password: " PFX_PASS; echo
  gh secret set WINDOWS_CERTIFICATE          --repo "$REPO" --body "$(base64 < "$PFX_PATH")"
  gh secret set WINDOWS_CERTIFICATE_PASSWORD --repo "$REPO" --body "$PFX_PASS"
fi

echo
echo "Done."
echo "Tag a release with: git tag v0.1.0 && git push origin v0.1.0"
echo "GitHub Actions will build, sign, notarize, and upload the signed bundles + latest.json."
