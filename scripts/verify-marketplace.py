"""Check released VSIX contents before granting the publishing job Azure access."""

import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


TARGETS = ("win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64")


def verify(root: Path, tag: str) -> None:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Expected a stable release tag such as v1.0.1")
    version = tag[1:]
    expected = {f"qbx-lua-{target}.vsix" for target in TARGETS}
    actual = {path.name for path in root.glob("*.vsix")}
    if actual != expected:
        raise ValueError(f"Expected all five platform packages; missing={expected - actual}, unexpected={actual - expected}")

    checksums = {}
    for line in (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([a-fA-F0-9]{64})  ([^/\\]+)", line)
        if not match or match[2] in checksums:
            raise ValueError("Invalid or duplicate SHA256SUMS entry")
        checksums[match[2]] = match[1].lower()

    for target in TARGETS:
        path = root / f"qbx-lua-{target}.vsix"
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != checksums.get(path.name):
            raise ValueError(f"Checksum mismatch or missing checksum: {path.name}")
        with zipfile.ZipFile(path) as package:
            names = package.namelist()
            if len(names) != len(set(names)):
                raise ValueError(f"Duplicate ZIP entries: {path.name}")
            manifest = json.loads(package.read("extension/package.json"))
            if (manifest.get("publisher", "").lower(), manifest.get("name"), manifest.get("version")) != (
                "qbox", "qbx-lua", version
            ):
                raise ValueError(f"Wrong extension identity or version: {path.name}")
            xml = ET.fromstring(package.read("extension.vsixmanifest"))
            identity = xml.find(".//{*}Identity")
            if identity is None or (
                identity.get("Publisher", "").lower(), identity.get("Id"),
                identity.get("Version"), identity.get("TargetPlatform")
            ) != ("qbox", "qbx-lua", version, target):
                raise ValueError(f"Wrong VSIX identity, version or target: {path.name}")
            binary = "qbx-lua-ls.exe" if target.startswith("win32-") else "qbx-lua-ls"
            server = f"extension/server/{target}/{binary}"
            if server not in names or package.getinfo(server).file_size == 0:
                raise ValueError(f"Missing bundled server: {path.name}")
        print(f"Verified {path.name} ({version})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python scripts/verify-marketplace.py ASSET_DIR RELEASE_TAG")
    try:
        verify(Path(sys.argv[1]), sys.argv[2])
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        sys.exit(str(error))
