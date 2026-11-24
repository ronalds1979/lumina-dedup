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
            drive_root = str(Path(tmpdir).anchor)
            if drive_root:
                with self.assertRaises(ValueError):
                    validate_scan_root(drive_root)

            reparse_stat = type("S", (), {"st_mode": 0o040755, "st_file_attributes": 0x400})()
            with patch("app.scanner.os.lstat", return_value=reparse_stat):
                with self.assertRaises(ValueError):
                    validate_scan_root(tmpdir)


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


if __name__ == "__main__":
    unittest.main()
