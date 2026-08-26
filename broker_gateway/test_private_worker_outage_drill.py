import json
import tempfile
import unittest
from pathlib import Path

from private_worker_outage_drill import run_drill


class PrivateWorkerOutageDrillTests(unittest.TestCase):
    def test_outage_after_attempt_is_never_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "evidence.json"
            result = run_drill(output)
            self.assertTrue(result["passed"])
            self.assertEqual(result["brokerPostAttempts"], 1)
            self.assertEqual(result["automaticRetryAttempts"], 0)
            self.assertTrue(result["secondRunReconcileOnly"])
            self.assertTrue(result["manualRecoveryRequired"])
            self.assertFalse(result["networkContacted"])
            self.assertFalse(result["brokerContacted"])
            self.assertEqual(json.loads(output.read_text())["mutationAuthorized"], False)


if __name__ == "__main__":
    unittest.main()
