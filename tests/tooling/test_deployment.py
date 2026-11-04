"""Deployment safety checks are offline and cannot execute a change set."""

import copy
import importlib.util
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from botocore.exceptions import ClientError

spec = importlib.util.spec_from_file_location(
    "deployment", Path(__file__).resolve().parents[2] / "scripts/deployment.py"
)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.review = {
            "stackName": "orders-dev",
            "environment": "development",
            "revision": "abc123",
            "changeSetArn": "change-1",
            "stackId": "stack-1",
        }
        self.change = {
            "StackName": "orders-dev",
            "ChangeSetId": "change-1",
            "StackId": "stack-1",
            "Description": "aws-orders revision abc123",
            "Parameters": [
                {"ParameterKey": "EnvironmentName", "ParameterValue": "development"}
            ],
            "Status": "CREATE_COMPLETE",
            "ExecutionStatus": "AVAILABLE",
        }

    def validate(self, change):
        deployment.validate_review(
            self.review, change, "orders-dev", "development", "abc123"
        )

    def test_accepts_exact_reviewed_revision(self):
        self.validate(self.change)

    def test_rejects_replaced_stale_or_cross_environment_change_sets(self):
        for field, value in [
            ("ChangeSetId", "other"),
            ("StackId", "other"),
            ("StackName", "orders-prod"),
            ("Description", "other revision"),
            ("Status", "FAILED"),
            ("ExecutionStatus", "EXECUTE_COMPLETE"),
            (
                "Parameters",
                [{"ParameterKey": "EnvironmentName", "ParameterValue": "production"}],
            ),
        ]:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.change)
                changed[field] = value
                with self.assertRaises(ValueError):
                    self.validate(changed)

    def test_access_denial_is_not_treated_as_missing_stack(self):
        client = Mock()
        client.describe_stacks.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "not authorized"}},
            "DescribeStacks",
        )
        with self.assertRaises(ClientError):
            deployment.existing_stack(client, "orders-dev")

    def test_missing_stack_is_recognized(self):
        client = Mock()
        client.describe_stacks.side_effect = ClientError(
            {
                "Error": {
                    "Code": "ValidationError",
                    "Message": "Stack with id orders-dev does not exist",
                }
            },
            "DescribeStacks",
        )
        self.assertIsNone(deployment.existing_stack(client, "orders-dev"))

    def test_plan_preserves_parameters_and_never_executes(self):
        cf, s3 = Mock(), Mock()
        cf.describe_stacks.return_value = {
            "Stacks": [
                {
                    "StackStatus": "UPDATE_COMPLETE",
                    "Parameters": [
                        {
                            "ParameterKey": "OAuthCallbackUrl",
                            "ParameterValue": "https://example.test/callback",
                        }
                    ],
                }
            ]
        }
        cf.create_change_set.return_value = {"Id": "change-1", "StackId": "stack-1"}
        cf.describe_change_set.side_effect = [
            {
                **self.change,
                "Changes": [{"ResourceChange": {"LogicalResourceId": "A"}}],
                "NextToken": "next",
            },
            {"Changes": [{"ResourceChange": {"LogicalResourceId": "B"}}]},
        ]
        s3.put_object.return_value = {"VersionId": "version-1"}
        s3.meta.endpoint_url = "https://s3.sa-east-1.amazonaws.com"
        session = Mock()
        session.client.side_effect = lambda service: {"cloudformation": cf, "s3": s3}[
            service
        ]
        with TemporaryDirectory() as directory:
            template = Path(directory) / "template.yaml"
            template.write_text(
                "Parameters:\n  EnvironmentName: {Type: String}\n  OAuthCallbackUrl: {Type: String}\nResources: {}\n"
            )
            output = Path(directory) / "review.json"
            args = SimpleNamespace(
                stack_name="orders-dev",
                environment="development",
                revision="abc123",
                template=str(template),
                parameters_file=None,
                artifact_bucket="test-bucket",
                execution_role="test-role",
                review_file=str(output),
            )
            with patch("sys.stdout", new=io.StringIO()):
                deployment.plan(args, session)
            reviewed = json.loads(output.read_text())
        params = cf.create_change_set.call_args.kwargs["Parameters"]
        self.assertIn(
            {"ParameterKey": "OAuthCallbackUrl", "UsePreviousValue": True}, params
        )
        self.assertIn(
            {"ParameterKey": "EnvironmentName", "ParameterValue": "development"}, params
        )
        self.assertEqual(len(reviewed["changes"]), 2)
        cf.execute_change_set.assert_not_called()

    def test_apply_executes_only_reviewed_id_and_waits(self):
        cf = Mock()
        cf.describe_change_set.return_value = self.change
        cf.describe_stacks.return_value = {
            "Stacks": [{"StackStatus": "UPDATE_COMPLETE", "Outputs": []}]
        }
        session = Mock()
        session.client.return_value = cf
        with TemporaryDirectory() as directory:
            review = Path(directory) / "review.json"
            review.write_text(
                json.dumps(
                    {**self.review, "noChanges": False, "changeSetType": "UPDATE"}
                )
            )
            args = SimpleNamespace(
                stack_name="orders-dev",
                environment="development",
                revision="abc123",
                review_file=str(review),
            )
            with patch("sys.stdout", new=io.StringIO()):
                deployment.apply(args, session)
        self.assertEqual(
            cf.execute_change_set.call_args.kwargs["ChangeSetName"], "change-1"
        )
        cf.get_waiter.assert_called_once_with("stack_update_complete")
        cf.get_waiter.return_value.wait.assert_called_once()


if __name__ == "__main__":
    unittest.main()
