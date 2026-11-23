import unittest
from pydantic import ValidationError

from app.main import (
    CopilotRequest,
    DecisionRequest,
    DedupRunRequest,
    ExecuteRemovalRequest,
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


if __name__ == "__main__":
    unittest.main()
