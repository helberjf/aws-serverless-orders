import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "environment", Path(__file__).resolve().parents[2] / "scripts/verify-environment.py"
)
environment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(environment)


class EnvironmentGateTests(unittest.TestCase):
    def setUp(self):
        self.policy = {
            "deployment_branch_policy": {"custom_branch_policies": True},
            "can_admins_bypass": False,
            "protection_rules": [
                {
                    "type": "required_reviewers",
                    "reviewers": [{"type": "User", "reviewer": {"id": 1}}],
                }
            ],
        }
        self.branches = {"branch_policies": [{"name": "main", "type": "branch"}]}

    def invoke(self, ref="refs/heads/main"):
        def response(request, timeout):
            data = (
                self.branches
                if request.full_url.endswith("/deployment-branch-policies")
                else self.policy
            )
            return io.BytesIO(json.dumps(data).encode())

        with patch.dict(
            os.environ,
            {
                "GITHUB_REF": ref,
                "GITHUB_REPOSITORY": "owner/repo",
                "GH_TOKEN": "offline-test-token",
            },
        ), patch(
            "sys.argv", ["verify-environment.py", "--environment", "production"]
        ), patch.object(
            environment, "urlopen", side_effect=response
        ):
            environment.main()

    def test_protected_main_with_reviewers_passes(self):
        self.invoke()

    def test_non_main_is_rejected(self):
        with self.assertRaises(RuntimeError):
            self.invoke("refs/heads/feature/unreviewed")

    def test_no_reviewers_is_rejected(self):
        self.policy["protection_rules"] = []
        with self.assertRaises(RuntimeError):
            self.invoke()

    def test_administrator_bypass_is_rejected(self):
        self.policy["can_admins_bypass"] = True
        with self.assertRaises(RuntimeError):
            self.invoke()

    def test_tag_or_wildcard_branch_rule_is_rejected(self):
        for rule in [{"name": "main", "type": "tag"}, {"name": "*", "type": "branch"}]:
            with self.subTest(rule=rule):
                self.branches["branch_policies"] = [rule]
                with self.assertRaises(RuntimeError):
                    self.invoke()

    def test_unprotected_environment_is_rejected(self):
        self.policy["deployment_branch_policy"] = {}
        with self.assertRaises(RuntimeError):
            self.invoke()


if __name__ == "__main__":
    unittest.main()
