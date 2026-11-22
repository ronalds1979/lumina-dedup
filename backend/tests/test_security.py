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


if __name__ == "__main__":
    unittest.main()
