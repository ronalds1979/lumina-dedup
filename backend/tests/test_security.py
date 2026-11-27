import unittest
from pydantic import ValidationError

from app.main import (
    AutoSelectRequest,
    CopilotRequest,
    DecisionRequest,
    DedupRunRequest,
    ExecuteRemovalRequest,
    RestoreRequest,
    ScanRequest,
    SettingsRequest,
)
from app.config import BASE_DIR, DATA_DIR, DEFAULT_QUARANTINE_DIR
from app.scanner import validate_scan_root


class TestRequestModelSecurityBounds(unittest.TestCase):
    def test_dedup_run_request_enforces_bounds(self):
        valid = DedupRunRequest(approach="semantic", semantic_limit=200, semantic_threshold=0.92)
        self.assertEqual(valid.semantic_limit, 200)

        with self.assertRaises(ValidationError):
            DedupRunRequest(approach="semantic", semantic_limit=100000)
        with self.assertRaises(ValidationError):
            DedupRunRequest(approach="visual", max_distance=64)
        with self.assertRaises(ValidationError):
            DedupRunRequest(approach="burst", burst_seconds=float("inf"))
        with self.assertRaises(ValidationError):
            DedupRunRequest(approach="semantic", semantic_threshold=0.1)
        with self.assertRaises(ValidationError):
            DedupRunRequest(approach="invalid")

    def test_execute_removal_rejects_invalid_mode(self):
        self.assertEqual(ExecuteRemovalRequest(mode="quarantine").mode, "quarantine")
        self.assertEqual(ExecuteRemovalRequest(mode="trash").mode, "trash")
        with self.assertRaises(ValidationError):
            ExecuteRemovalRequest(mode="delete_all")
        with self.assertRaises(ValidationError):
            ExecuteRemovalRequest(file_ids=list(range(1, 10002)))
        with self.assertRaises(ValidationError):
            RestoreRequest(file_ids=list(range(1, 10002)))
        with self.assertRaises(ValidationError):
            AutoSelectRequest(rule="unknown_destructive_rule")
        with self.assertRaises(ValidationError):
            AutoSelectRequest(rule="keep_largest", approach="invalid")
        self.assertEqual(AutoSelectRequest(rule="keep_cleanest_path").rule, "keep_cleanest_path")

    def test_copilot_and_settings_and_scan_bounds(self):
        with self.assertRaises(ValidationError):
            CopilotRequest(message="")
        with self.assertRaises(ValidationError):
            CopilotRequest(message="a" * 4001)
        with self.assertRaises(ValidationError):
            ScanRequest(paths=[])
        with self.assertRaises(ValidationError):
            ScanRequest(paths=["C:\\tmp"] * 51)
        with self.assertRaises(ValidationError):
            SettingsRequest(gemini_api_key="x" * 257)
        with self.assertRaises(ValidationError):
            DecisionRequest(file_id=0, decision="keep")


class TestScanRootValidation(unittest.TestCase):
    def test_validate_scan_root_blocks_unc_protected_and_reparse_roots(self):
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        for unsafe in (r"\\attacker.example\share", "//attacker.example/share", r"\\.\C:\Windows"):
            with self.assertRaises(ValueError):
                validate_scan_root(unsafe)

        for protected in (str(BASE_DIR), str(DATA_DIR), str(DEFAULT_QUARANTINE_DIR)):
            with self.assertRaises(ValueError):
                validate_scan_root(protected)

        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertEqual(validate_scan_root(tmpdir), str(Path(tmpdir).resolve()))
            sys_root = Path(os.environ.get("SystemRoot", "/")).resolve().anchor
            if sys_root:
                with self.assertRaises(ValueError):
                    validate_scan_root(sys_root)

            reparse_stat = type("S", (), {"st_mode": 0o040755, "st_file_attributes": 0x400})()
            with patch("app.scanner.os.lstat", return_value=reparse_stat):
                with self.assertRaises(ValueError):
                    validate_scan_root(tmpdir)

    def test_validate_scan_root_allows_secondary_media_drive_roots(self):
        import os
        from pathlib import Path
        from unittest.mock import patch

        if os.name == "nt":
            normal_dir_stat = type("S", (), {"st_mode": 0o040755, "st_file_attributes": 0x10})()
            with (
                patch.dict(os.environ, {"SystemDrive": "C:", "SystemRoot": r"C:\Windows"}, clear=False),
                patch("app.scanner.os.path.islink", return_value=False),
                patch("app.scanner.os.lstat", return_value=normal_dir_stat),
                patch.object(Path, "resolve", autospec=True, side_effect=lambda self, *a, **kw: Path("D:\\") if str(self).upper().startswith("D:") else Path(os.fspath(self))),
                patch.object(Path, "is_dir", return_value=True),
            ):
                self.assertEqual(validate_scan_root("D:\\"), "D:\\")
                self.assertEqual(validate_scan_root("D:"), "D:\\")
                with self.assertRaises(ValueError):
                    validate_scan_root("C:\\")

    def test_safe_relative_dest_handles_windows_drive_roots_and_subfolders(self):
        import tempfile
        from pathlib import Path
        from app.safety import _safe_relative_dest

        with tempfile.TemporaryDirectory() as tmpdir:
            batch_dir = Path(tmpdir) / "batch_1"
            dest_root_file = _safe_relative_dest(r"D:\IMG_0001.JPG", batch_dir)
            self.assertTrue(dest_root_file.resolve().is_relative_to(batch_dir.resolve()))
            dest_sub_file = _safe_relative_dest(r"D:\Photos\2026\IMG_0002.JPG", batch_dir)
            self.assertTrue(dest_sub_file.resolve().is_relative_to(batch_dir.resolve()))


class TestHostHeaderSecurity(unittest.TestCase):
    def test_blocks_dns_rebinding_hosts_and_allows_local_hosts(self):
        from fastapi.testclient import TestClient
        from app.main import app

        with TestClient(app, base_url="http://127.0.0.1:8000") as client:
            for valid_host in ("127.0.0.1:8000", "localhost:8000", "[::1]:8000", "localhost:5173"):
                resp = client.get("/api/health", headers={"Host": valid_host})
                self.assertEqual(resp.status_code, 200, f"Expected 200 for {valid_host}")

            for evil_host in (
                "rebind.attacker.example:8000",
                "localhost.attacker.example:8000",
                "evil@127.0.0.1:8000",
                "",
            ):
                resp = client.get("/api/health", headers={"Host": evil_host})
                self.assertEqual(resp.status_code, 403, f"Expected 403 for {evil_host}")


class TestNestedJunctionAndSemanticLimitSecurity(unittest.TestCase):
    def test_walk_media_skips_nested_reparse_directories(self):
        import os
        import tempfile
        from unittest.mock import patch
        from app.scanner import _walk_media

        with tempfile.TemporaryDirectory() as tmpdir:
            safe_sub = os.path.join(tmpdir, "safe")
            junction_sub = os.path.join(tmpdir, "junction_escape")
            os.makedirs(safe_sub)
            os.makedirs(junction_sub)
            with open(os.path.join(safe_sub, "keep.jpg"), "wb") as f:
                f.write(b"ok")
            with open(os.path.join(junction_sub, "secret.jpg"), "wb") as f:
                f.write(b"secret")

            with patch("app.scanner._is_reparse_dir", side_effect=lambda p: os.path.abspath(p) == os.path.abspath(junction_sub)):
                found = [entry.name for entry, _ in _walk_media(tmpdir)]
            self.assertEqual(found, ["keep.jpg"])

    def test_semantic_dedup_clustering_query_enforces_limit(self):
        import inspect
        from app import gemini_ai

        src = inspect.getsource(gemini_ai.run_semantic_dedup)
        self.assertGreaterEqual(src.count("LIMIT ?"), 2)

    def test_is_unsafe_local_path_blocks_unc_and_reparse_lineage(self):
        import os
        import tempfile
        from unittest.mock import patch
        from app.safety import is_unsafe_local_path

        for unc in (r"\\attacker.example\share\photo.jpg", "//attacker.example/share/photo.jpg", r"\\.\C:\photo.jpg"):
            with patch("app.safety.os.lstat", side_effect=AssertionError("lstat must not run on UNC/device paths")):
                self.assertTrue(is_unsafe_local_path(unc))

        with tempfile.TemporaryDirectory() as tmpdir:
            nested = os.path.join(tmpdir, "sub", "photo.jpg")
            os.makedirs(os.path.dirname(nested))
            with open(nested, "wb") as f:
                f.write(b"ok")
            self.assertFalse(is_unsafe_local_path(nested))

            reparse_stat = type("S", (), {"st_file_attributes": 0x400})()
            normal_stat = type("S", (), {"st_file_attributes": 0x10})()
            sub_abs = os.path.abspath(os.path.dirname(nested))
            with patch("app.safety.stat.FILE_ATTRIBUTE_REPARSE_POINT", 0x400, create=True), patch(
                "app.safety.os.lstat",
                side_effect=lambda p: reparse_stat if os.path.abspath(p) == sub_abs else normal_stat,
            ):
                self.assertTrue(is_unsafe_local_path(nested))


if __name__ == "__main__":
    unittest.main()
