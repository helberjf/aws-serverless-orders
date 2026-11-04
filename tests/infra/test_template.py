"""Offline checks against the actual SAM-to-CloudFormation transformation."""

import copy
import json
import os
from pathlib import Path
import unittest
import yaml
from samtranslator.translator.transform import transform

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
HTTP = ["CreateOrderFunction", "GetOrderFunction", "HealthFunction"]


class NoManagedPolicies:
    def load(self):
        raise AssertionError(
            "All function and deployment roles must be explicit and scoped"
        )


class InfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = yaml.safe_load((ROOT / "template.yaml").read_text())
        packaged = copy.deepcopy(cls.template)
        for resource in packaged["Resources"].values():
            if resource["Type"] == "AWS::Serverless::Function":
                resource["Properties"]["CodeUri"] = {
                    "Bucket": "offline-build-artifacts",
                    "Key": "revision.zip",
                }
        cls.expanded = transform(packaged, {}, NoManagedPolicies())
        cls.resources = cls.expanded["Resources"]

    def test_api_integrations_invoke_live_aliases(self):
        paths = self.resources["ServerlessRestApi"]["Properties"]["Body"]["paths"]
        for path, verb, function in [
            ("/orders", "post", HTTP[0]),
            ("/orders/{orderId}", "get", HTTP[1]),
            ("/health", "get", HTTP[2]),
        ]:
            integration = paths[path][verb]["x-amazon-apigateway-integration"]
            self.assertIn(function + "Aliaslive", json.dumps(integration["uri"]))
            alias = self.resources[function + "Aliaslive"]
            self.assertEqual(alias["Type"], "AWS::Lambda::Alias")
            self.assertEqual(alias["Properties"]["Name"], "live")
            version = alias["Properties"]["FunctionVersion"]["Fn::GetAtt"][0]
            self.assertEqual(self.resources[version]["Type"], "AWS::Lambda::Version")
            self.assertIn("CodeDeployLambdaAliasUpdate", alias["UpdatePolicy"])

    def test_canaries_include_http_failure_alarm_and_automatic_rollback(self):
        for function in HTTP:
            group = self.resources[function + "DeploymentGroup"]["Properties"]
            self.assertIn(
                "Canary10Percent10Minutes", json.dumps(group["DeploymentConfigName"])
            )
            self.assertTrue(group["AutoRollbackConfiguration"]["Enabled"])
            self.assertIn(
                "DEPLOYMENT_STOP_ON_ALARM", group["AutoRollbackConfiguration"]["Events"]
            )
            self.assertTrue(group["AlarmConfiguration"]["Enabled"])
            self.assertIn(
                "ApiServerErrorsAlarm",
                json.dumps(group["AlarmConfiguration"]["Alarms"]),
            )
            self.assertEqual(
                group["ServiceRoleArn"], {"Fn::GetAtt": ["CanaryDeploymentRole", "Arn"]}
            )

    def test_cognito_scopes_and_public_health(self):
        paths = self.resources["ServerlessRestApi"]["Properties"]["Body"]["paths"]
        self.assertEqual(
            paths["/orders"]["post"]["security"],
            [{"OrdersCognitoAuth": ["orders/write"]}],
        )
        self.assertEqual(
            paths["/orders/{orderId}"]["get"]["security"],
            [{"OrdersCognitoAuth": ["orders/read"]}],
        )
        self.assertEqual(paths["/health"]["get"]["security"], [{"NONE": []}])

    def test_pollers_allow_partial_failures_and_sufficient_visibility(self):
        for function, event, queue in [
            ("ProcessOrderFunction", "Orders", "OrdersQueue"),
            ("NotifyOrderFunction", "Notifications", "NotificationsQueue"),
        ]:
            source = self.template["Resources"][function]["Properties"]
            mapping = source["Events"][event]["Properties"]
            self.assertEqual(
                mapping["FunctionResponseTypes"], ["ReportBatchItemFailures"]
            )
            self.assertGreaterEqual(
                self.template["Resources"][queue]["Properties"]["VisibilityTimeout"],
                6 * source["Timeout"] + mapping["MaximumBatchingWindowInSeconds"],
            )
            self.assertEqual(
                self.template["Resources"][queue]["Properties"]["RedrivePolicy"][
                    "maxReceiveCount"
                ],
                5,
            )

    def test_business_data_is_retained_and_only_temporary_tables_have_ttl(self):
        tables = {
            k: v
            for k, v in self.resources.items()
            if v["Type"] == "AWS::DynamoDB::Table"
        }
        for name, table in tables.items():
            self.assertEqual(table["DeletionPolicy"], "Retain")
            self.assertEqual(table["Properties"]["BillingMode"], "PAY_PER_REQUEST")
            self.assertEqual(
                "TimeToLiveSpecification" in table["Properties"],
                name in ("IdempotencyTable", "OutboxTable"),
            )

    def test_function_roles_have_no_unjustified_global_permissions(self):
        roles = []
        for resource in self.resources.values():
            if resource["Type"] == "AWS::Lambda::Function":
                role = resource["Properties"]["Role"]["Fn::GetAtt"][0]
                roles.append(role)
                policy = self.resources[role]["Properties"]
                self.assertFalse(policy.get("ManagedPolicyArns"))
                for item in policy["Policies"]:
                    for statement in item["PolicyDocument"]["Statement"]:
                        self.assertNotIn(
                            "*",
                            (
                                statement["Action"]
                                if isinstance(statement["Action"], list)
                                else [statement["Action"]]
                            ),
                        )
                        if statement["Resource"] == "*":
                            self.assertEqual(
                                set(statement["Action"]),
                                {"xray:PutTraceSegments", "xray:PutTelemetryRecords"},
                            )
        self.assertEqual(len(roles), len(set(roles)))
        self.assertEqual(len(roles), 7)

    def test_no_permanent_compute_and_log_retention_is_bounded(self):
        for resource in self.resources.values():
            self.assertNotIn(
                resource["Type"],
                [
                    "AWS::EC2::NatGateway",
                    "AWS::ECS::Service",
                    "AWS::RDS::DBInstance",
                    "AWS::ElasticLoadBalancingV2::LoadBalancer",
                ],
            )
            if resource["Type"] == "AWS::Logs::LogGroup":
                self.assertEqual(resource["Properties"]["RetentionInDays"], 14)

    def test_recovery_query_authorizes_the_table_and_its_specific_index(self):
        # DynamoDB Query requires table authorization as well as the selected GSI.
        statements = self.resources["ReconcileOutboxFunctionRole"]["Properties"][
            "Policies"
        ][0]["PolicyDocument"]["Statement"]
        resources = []
        for statement in statements:
            actions = statement["Action"]
            if "dynamodb:Query" in (
                actions if isinstance(actions, list) else [actions]
            ):
                resource = statement["Resource"]
                resources.extend(resource if isinstance(resource, list) else [resource])
        self.assertIn({"Fn::GetAtt": ["OutboxTable", "Arn"]}, resources)
        self.assertIn(
            {"Fn::Sub": "${OutboxTable.Arn}/index/PendingByNextAttempt"}, resources
        )
        self.assertEqual(len(resources), 2)


if __name__ == "__main__":
    unittest.main()
