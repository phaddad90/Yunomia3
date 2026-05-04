#!/usr/bin/env python3
# Copy the bundles tauri-action produced into a flat staging dir, renaming
# the macOS updater tarball so its arch is in the filename (tauri-action
# normally does this rename during release upload, which we now skip).

import json
import os
import shutil
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: stage-artifacts.py <artifact-paths-json> <arch-suffix> <dest>", file=sys.stderr)
        return 2

    paths = json.loads(sys.argv[1] or "[]")
    arch_suffix = sys.argv[2]
    dest = sys.argv[3]
    os.makedirs(dest, exist_ok=True)

    for src in paths:
        if not os.path.isfile(src):
            continue
        name = os.path.basename(src)
        if arch_suffix and name.startswith("Yunomia.app.tar.gz"):
            name = name.replace("Yunomia.app.tar.gz", f"Yunomia_{arch_suffix}.app.tar.gz", 1)
        shutil.copy(src, os.path.join(dest, name))

    for f in sorted(os.listdir(dest)):
        print(f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
