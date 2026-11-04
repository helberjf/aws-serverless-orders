"""Create or apply a reviewable CloudFormation change set; plan never executes it."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import quote
import uuid

import boto3
from botocore.exceptions import ClientError
import yaml


def existing_stack(client, name):
    try:
        return client.describe_stacks(StackName=name)["Stacks"][0]
    except ClientError as error:
        detail = error.response["Error"]
        if (
            detail["Code"] == "ValidationError"
            and "does not exist" in detail["Message"]
        ):
            return None
        raise  # Never interpret access denial or a network error as an empty account.


def validate_review(review, change, stack_name, environment, revision):
    for field, expected in [
        ("stackName", stack_name),
        ("environment", environment),
        ("revision", revision),
    ]:
        if review[field] != expected:
            raise ValueError(f"Review does not match expected {field}")
    if (
        change["ChangeSetId"] != review["changeSetArn"]
        or change["StackId"] != review["stackId"]
    ):
        raise ValueError("Change set or stack identity changed")
    if (
        change["StackName"] != stack_name
        or change.get("Description") != f"aws-orders revision {revision}"
    ):
        raise ValueError("CloudFormation revision does not match the reviewed artifact")
    parameters = {
        p["ParameterKey"]: p.get("ParameterValue") for p in change["Parameters"]
    }
    if parameters.get("EnvironmentName") != environment:
        raise ValueError("CloudFormation environment mismatch")
    if (
        change["Status"] != "CREATE_COMPLETE"
        or change["ExecutionStatus"] != "AVAILABLE"
    ):
        raise ValueError("Change set is not available for execution")


def plan(args, session):
    cf = session.client("cloudformation")
    stack = existing_stack(cf, args.stack_name)
    if stack and stack["StackStatus"] not in (
        "CREATE_COMPLETE",
        "UPDATE_COMPLETE",
        "UPDATE_ROLLBACK_COMPLETE",
        "REVIEW_IN_PROGRESS",
    ):
        raise RuntimeError(
            "Resolve the existing stack operation before planning another deployment"
        )
    change_type = (
        "UPDATE" if stack and stack["StackStatus"] != "REVIEW_IN_PROGRESS" else "CREATE"
    )
    content = Path(args.template).read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    template = yaml.safe_load(content)
    supplied = (
        json.loads(Path(args.parameters_file).read_text())
        if args.parameters_file
        else {}
    )
    if not isinstance(supplied, dict) or any(
        not isinstance(v, str) for v in supplied.values()
    ):
        raise ValueError("Parameters must be a JSON object of string values")
    if supplied.get("EnvironmentName", args.environment) != args.environment:
        raise ValueError("EnvironmentName cannot override the selected environment")
    supplied["EnvironmentName"] = args.environment
    unknown = set(supplied) - set(template.get("Parameters", {}))
    if unknown:
        raise ValueError(f"Unknown template parameters: {sorted(unknown)}")
    previous = (
        {p["ParameterKey"] for p in stack.get("Parameters", [])} if stack else set()
    )
    parameters = [{"ParameterKey": k, "ParameterValue": v} for k, v in supplied.items()]
    parameters.extend(
        {"ParameterKey": k, "UsePreviousValue": True}
        for k in previous & set(template.get("Parameters", {})) - set(supplied)
    )
    key = f"{args.stack_name}/templates/{args.revision}-{uuid.uuid4().hex}.yaml"
    s3 = session.client("s3")
    result = s3.put_object(
        Bucket=args.artifact_bucket,
        Key=key,
        Body=content,
        ServerSideEncryption="AES256",
        ContentType="application/yaml",
    )
    if not result.get("VersionId"):
        raise RuntimeError("Artifact bucket must have versioning enabled")
    template_url = f'{s3.meta.endpoint_url}/{args.artifact_bucket}/{key}?versionId={quote(result["VersionId"], safe="")}'
    created = cf.create_change_set(
        StackName=args.stack_name,
        ChangeSetName=f"revision-{args.revision[:12]}-{uuid.uuid4().hex[:8]}",
        ChangeSetType=change_type,
        TemplateURL=template_url,
        RoleARN=args.execution_role,
        Capabilities=["CAPABILITY_IAM"],
        Description=f"aws-orders revision {args.revision}",
        Parameters=parameters,
        Tags=[
            {"Key": "Project", "Value": args.stack_name},
            {"Key": "Environment", "Value": args.environment},
            {"Key": "Revision", "Value": args.revision},
        ],
    )
    deadline = time.monotonic() + 300
    while True:
        change = cf.describe_change_set(
            ChangeSetName=created["Id"], StackName=created["StackId"]
        )
        if change["Status"] not in ("CREATE_PENDING", "CREATE_IN_PROGRESS"):
            break
        if time.monotonic() > deadline:
            raise TimeoutError(f'Change set is still being created: {created["Id"]}')
        time.sleep(3)
    reason = change.get("StatusReason", "")
    no_changes = change["Status"] == "FAILED" and (
        "didn't contain changes" in reason or "No updates are to be performed" in reason
    )
    if change["Status"] != "CREATE_COMPLETE" and not no_changes:
        raise RuntimeError(f"Change set failed: {reason}")
    changes = list(change.get("Changes", []))
    page = change
    while page.get("NextToken"):
        page = cf.describe_change_set(
            ChangeSetName=created["Id"],
            StackName=created["StackId"],
            NextToken=page["NextToken"],
        )
        changes.extend(page.get("Changes", []))
    review = {
        "stackName": args.stack_name,
        "stackId": created["StackId"],
        "environment": args.environment,
        "revision": args.revision,
        "changeSetArn": created["Id"],
        "changeSetType": change_type,
        "templateSha256": digest,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "noChanges": no_changes,
        "changes": changes,
    }
    output = Path(args.review_file)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(review, indent=2, default=str) + "\n", encoding="utf-8"
    )
    print(json.dumps(review, indent=2, default=str))


def apply(args, session):
    review = json.loads(Path(args.review_file).read_text())
    if any(
        review[k] != v
        for k, v in [
            ("stackName", args.stack_name),
            ("environment", args.environment),
            ("revision", args.revision),
        ]
    ):
        raise ValueError("Review artifact does not belong to this deployment")
    if review["noChanges"]:
        print("No infrastructure or code changes; nothing executed.")
        return
    cf = session.client("cloudformation")
    change = cf.describe_change_set(
        ChangeSetName=review["changeSetArn"], StackName=review["stackId"]
    )
    validate_review(review, change, args.stack_name, args.environment, args.revision)
    cf.execute_change_set(
        ChangeSetName=review["changeSetArn"],
        StackName=review["stackId"],
        ClientRequestToken=f"approved-{uuid.uuid4()}",
    )
    waiter = (
        "stack_create_complete"
        if review["changeSetType"] == "CREATE"
        else "stack_update_complete"
    )
    cf.get_waiter(waiter).wait(
        StackName=review["stackId"], WaiterConfig={"Delay": 20, "MaxAttempts": 120}
    )
    stack = cf.describe_stacks(StackName=review["stackId"])["Stacks"][0]
    print(
        json.dumps(
            {"stackStatus": stack["StackStatus"], "outputs": stack.get("Outputs", [])},
            indent=2,
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["plan", "apply"])
    parser.add_argument("--stack-name", required=True)
    parser.add_argument(
        "--environment", choices=["development", "production"], required=True
    )
    parser.add_argument("--revision", required=True)
    parser.add_argument("--region", default="sa-east-1")
    parser.add_argument("--review-file", default=".deploy/review.json")
    parser.add_argument("--template", default=".deploy/packaged.yaml")
    parser.add_argument("--artifact-bucket")
    parser.add_argument("--execution-role")
    parser.add_argument("--parameters-file")
    args = parser.parse_args()
    if args.operation == "plan" and not (args.artifact_bucket and args.execution_role):
        parser.error("plan requires --artifact-bucket and --execution-role")
    session = boto3.Session(region_name=args.region)
    (plan if args.operation == "plan" else apply)(args, session)


if __name__ == "__main__":
    main()
