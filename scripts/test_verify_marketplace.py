import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location("verify_marketplace", Path(__file__).with_name("verify-marketplace.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class ReleasePackagesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for target in verifier.TARGETS:
            self.package(target)
        self.checksums()

    def package(self, target, *, publisher="qbox", version="1.0.1", xml_target=None, server=True):
        path = self.root / f"qbx-lua-{target}.vsix"
        manifest = {"publisher": publisher, "name": "qbx-lua", "version": version}
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("extension/package.json", json.dumps(manifest))
            archive.writestr("extension.vsixmanifest", (
                '<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
                f'<Metadata><Identity Publisher="{publisher}" Id="qbx-lua" Version="{version}" '
                f'TargetPlatform="{xml_target or target}" /></Metadata></PackageManifest>'
            ))
            if server:
                binary = "qbx-lua-ls.exe" if target.startswith("win32-") else "qbx-lua-ls"
                archive.writestr(f"extension/server/{target}/{binary}", b"test server")
        return path

    def checksums(self):
        lines = [f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
                 for path in sorted(self.root.glob("*.vsix"))]
        (self.root / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")

    def test_complete_release_and_publisher_case(self):
        self.package("win32-x64", publisher="Qbox")
        self.checksums()
        verifier.verify(self.root, "v1.0.1")

    def test_missing_platform(self):
        (self.root / "qbx-lua-linux-arm64.vsix").unlink()
        with self.assertRaisesRegex(ValueError, "all five"):
            verifier.verify(self.root, "v1.0.1")

    def test_extra_universal_package(self):
        (self.root / "qbx-lua.vsix").write_bytes(b"unexpected")
        with self.assertRaisesRegex(ValueError, "unexpected"):
            verifier.verify(self.root, "v1.0.1")

    def test_corrupted_download(self):
        (self.root / "qbx-lua-linux-x64.vsix").write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "Checksum"):
            verifier.verify(self.root, "v1.0.1")

    def test_wrong_version_publisher_target_or_missing_server(self):
        cases = (
            ({"version": "1.0.0"}, "identity or version"),
            ({"publisher": "another-publisher"}, "identity or version"),
            ({"xml_target": "darwin-x64"}, "target"),
            ({"server": False}, "Missing bundled server"),
        )
        for kwargs, error in cases:
            with self.subTest(kwargs=kwargs):
                self.package("linux-x64", **kwargs)
                self.checksums()
                with self.assertRaisesRegex(ValueError, error):
                    verifier.verify(self.root, "v1.0.1")

    def test_duplicate_checksum(self):
        path = self.root / "SHA256SUMS"
        text = path.read_text(encoding="utf-8")
        path.write_text(text + text.splitlines()[0] + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            verifier.verify(self.root, "v1.0.1")

    def test_invalid_tag(self):
        with self.assertRaisesRegex(ValueError, "stable release"):
            verifier.verify(self.root, "main")


if __name__ == "__main__":
    unittest.main()
