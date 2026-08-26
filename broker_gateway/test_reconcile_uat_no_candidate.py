import unittest

from reconcile_uat_no_candidate import collect_no_candidate_proof
from uat_order_cycle import CycleError


def payload(data):
    return {"ok": True, "environment": "uat", "data": data}


class ReconcileNoCandidateTests(unittest.TestCase):
    def requester(self, method, path):
        self.assertEqual(method, "GET")
        if path == "/v1/account-snapshot":
            return payload({"environment": "uat", "portfolio": [], "orders": []})
        if path == "/v1/recovery/candidates":
            return payload({
                "environment": "uat",
                "operations": [{
                    "requestId": "request-001",
                    "classification": "NO_CANDIDATE",
                    "matchCount": 0,
                }],
            })
        raise AssertionError(path)

    def test_collects_three_clean_read_only_samples(self):
        proof = collect_no_candidate_proof(
            self.requester, "request-001", sample_count=3, delay_seconds=0
        )
        self.assertEqual(len(proof["samples"]), 3)
        self.assertTrue(all(item["orders"] == 0 for item in proof["samples"]))

    def test_refuses_fewer_than_three_samples(self):
        with self.assertRaisesRegex(CycleError, "THREE_RECONCILIATION_SAMPLES_REQUIRED"):
            collect_no_candidate_proof(
                self.requester, "request-001", sample_count=2, delay_seconds=0
            )

    def test_refuses_any_broker_candidate(self):
        def requester(method, path):
            result = self.requester(method, path)
            if path == "/v1/recovery/candidates":
                result["data"]["operations"][0].update({
                    "classification": "EXACTLY_ONE_CANDIDATE", "matchCount": 1,
                })
            return result

        with self.assertRaisesRegex(CycleError, "NO_CANDIDATE_NOT_PROVEN"):
            collect_no_candidate_proof(
                requester, "request-001", sample_count=3, delay_seconds=0
            )


if __name__ == "__main__":
    unittest.main()
