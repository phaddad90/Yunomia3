#!/usr/bin/env python3
# Reconstruct the Tauri updater manifest from staged bundles.
#
# Why this exists: when the matrix release workflow had every job try to
# update the GitHub Release in parallel, two of four jobs always lost the
# `Error updating policy` race and the manifest ended up missing entries.
# We now build + sign in the matrix, ship artifacts to a single publish job,
# and assemble latest.json once from the .sig files staged here.

import datetime
import json
import os
import sys


def read_sig(path: str) -> str:
    with open(path, "r") as f:
        return f.read().strip()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: build-latest-json.py <dist-dir>", file=sys.stderr)
        return 2

    dist = sys.argv[1]
    tag = os.environ["TAG"]
    repo = os.environ["REPO"]
    version = tag[1:] if tag.startswith("v") else tag

    def url(name: str) -> str:
        return f"https://github.com/{repo}/releases/download/{tag}/{name}"

    def entry_if(bundle_name: str):
        sig = os.path.join(dist, bundle_name + ".sig")
        if os.path.exists(sig):
            return {"signature": read_sig(sig), "url": url(bundle_name)}
        return None

    platforms: dict = {}

    for arch_label, key in [("aarch64", "darwin-aarch64"), ("x64", "darwin-x86_64")]:
        e = entry_if(f"Yunomia_{arch_label}.app.tar.gz")
        if e:
            platforms[key] = e
            platforms[f"{key}-app"] = e

    nsis = entry_if(f"Yunomia_{version}_x64-setup.exe")
    if nsis:
        platforms["windows-x86_64"] = nsis
        platforms["windows-x86_64-nsis"] = nsis

    msi = entry_if(f"Yunomia_{version}_x64_en-US.msi")
    if msi:
        platforms["windows-x86_64-msi"] = msi

    appimage = entry_if(f"Yunomia_{version}_amd64.AppImage")
    if appimage:
        platforms["linux-x86_64"] = appimage

    if not platforms:
        print("error: no signed bundles found in " + dist, file=sys.stderr)
        return 1

    manifest = {
        "version": version,
        "notes": (
            f"See [README](https://github.com/{repo}/blob/main/README.md) "
            "for install instructions.\n"
            "In-app update users will be prompted automatically on next launch."
        ),
        "pub_date": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "platforms": platforms,
    }
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
