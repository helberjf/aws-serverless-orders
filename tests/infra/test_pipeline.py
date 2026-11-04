import json
from fnmatch import fnmatchcase
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


class PipelineInfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resources = yaml.safe_load((ROOT / "infra/github-oidc.yaml").read_text())[
            "Resources"
        ]
        cls.workflow = yaml.load(
            (ROOT / ".github/workflows/deploy.yml").read_text(), Loader=yaml.BaseLoader
        )

    def statements(self, role):
        return self.resources[role]["Properties"]["Policies"][0]["PolicyDocument"][
            "Statement"
        ]

    def test_oidc_is_bound_to_one_repository_and_exact_environments(self):
        for role, suffix in [
            ("PlanRole", "${EnvironmentName}-plan"),
            ("DeployRole", "${EnvironmentName}"),
        ]:
            trust = self.resources[role]["Properties"]["AssumeRolePolicyDocument"][
                "Statement"
            ][0]
            self.assertEqual(trust["Action"], "sts:AssumeRoleWithWebIdentity")
            conditions = trust["Condition"]["StringEquals"]
            self.assertEqual(
                conditions["token.actions.githubusercontent.com:aud"],
                "sts.amazonaws.com",
            )
            self.assertEqual(
                conditions["token.actions.githubusercontent.com:sub"],
                {"Fn::Sub": "repo:${GitHubRepository}:environment:" + suffix},
            )

    def test_plan_cannot_execute_and_deploy_cannot_create_another_plan(self):
        def actions(role):
            return {
                a
                for statement in self.statements(role)
                for a in (
                    statement["Action"]
                    if isinstance(statement["Action"], list)
                    else [statement["Action"]]
                )
            }

        self.assertNotIn("cloudformation:ExecuteChangeSet", actions("PlanRole"))
        self.assertIn("cloudformation:CreateChangeSet", actions("PlanRole"))
        self.assertIn("cloudformation:ExecuteChangeSet", actions("DeployRole"))
        self.assertNotIn("cloudformation:CreateChangeSet", actions("DeployRole"))
        self.assertNotIn("iam:PassRole", actions("DeployRole"))
        self.assertEqual(
            self.resources["CloudFormationExecutionRole"]["Properties"]["Path"],
            "/aws-orders-ci/",
        )

    def test_global_execution_permissions_are_an_explicit_allowlist(self):
        allowed = {
            "CreateMappingNeedsWildcard",
            "DescribeLogGroupsNeedsWildcard",
            "CreateUserPoolNeedsWildcard",
            "CreateOptionalAlarmKeyNeedsWildcard",
            "DomainLookupAndDeploymentControlNeedWildcard",
        }
        for statement in self.statements("CloudFormationExecutionRole"):
            actions = (
                statement["Action"]
                if isinstance(statement["Action"], list)
                else [statement["Action"]]
            )
            self.assertTrue(all("*" not in a for a in actions))
            if statement["Resource"] == "*":
                self.assertIn(statement["Sid"], allowed)
                self.assertIn("aws:RequestedRegion", json.dumps(statement["Condition"]))

    def test_subscription_lifecycle_authorizes_parent_topics(self):
        # SNS authorizes subscription operations against the parent topic ARN:
        # https://docs.aws.amazon.com/service-authorization/latest/reference/list_sns.html
        statements = self.statements("CloudFormationExecutionRole")
        values = {
            "AWS::Partition": "aws",
            "AWS::Region": "sa-east-1",
            "AWS::AccountId": "123456789012",
            "ApplicationStackName": "orders-development",
        }
        for action in (
            "sns:GetSubscriptionAttributes",
            "sns:SetSubscriptionAttributes",
            "sns:Unsubscribe",
        ):
            patterns = []
            for statement in statements:
                if action not in statement["Action"]:
                    continue
                resource = statement["Resource"]["Fn::Sub"]
                for key, value in values.items():
                    resource = resource.replace("${" + key + "}", value)
                patterns.append(resource)
            for topic in ("NotificationsTopic", "AlarmTopic"):
                with self.subTest(action=action, topic=topic):
                    arn = f"arn:aws:sns:sa-east-1:123456789012:orders-development-{topic}-generated"
                    self.assertTrue(any(fnmatchcase(arn, p) for p in patterns))
            other = "arn:aws:sns:sa-east-1:123456789012:orders-production-NotificationsTopic-generated"
            self.assertFalse(any(fnmatchcase(other, p) for p in patterns))

    def test_deployment_is_manual_and_apply_waits_for_reviewable_plan(self):
        self.assertEqual(set(self.workflow["on"]), {"workflow_dispatch"})
        self.assertEqual(self.workflow["jobs"]["apply"]["needs"], "plan")
        self.assertEqual(
            self.workflow["jobs"]["apply"]["environment"], "${{ inputs.environment }}"
        )
        self.assertEqual(self.workflow["concurrency"]["cancel-in-progress"], "false")
        for workflow in (
            self.workflow,
            yaml.load(
                (ROOT / ".github/workflows/ci.yml").read_text(), Loader=yaml.BaseLoader
            ),
        ):
            for job in workflow["jobs"].values():
                for step in job.get("steps", []):
                    if "uses" in step:
                        self.assertRegex(step["uses"], r"@[a-f0-9]{40}$")


if __name__ == "__main__":
    unittest.main()
