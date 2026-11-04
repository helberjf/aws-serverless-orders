"""Live development E2E: Cognito -> API -> outbox -> SQS -> fulfillment -> EventBridge -> SNS."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid
import boto3


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def token_file(path):
    token = json.loads(Path(path).read_text())
    check(
        token.get("expires_at", 0) > time.time(),
        "Token expired; run scripts/login.py again",
    )
    return token["access_token"]


def wait_for_message(client, queue, predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = client.receive_message(
            QueueUrl=queue,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=10,
            VisibilityTimeout=10,
        )
        for message in result.get("Messages", []):
            try:
                body = json.loads(message["Body"])
                matched = predicate(body)
            except (json.JSONDecodeError, TypeError, AttributeError):
                matched = False
            finally:
                # Leave all messages, including the test evidence, in their queues.
                client.change_message_visibility(
                    QueueUrl=queue,
                    ReceiptHandle=message["ReceiptHandle"],
                    VisibilityTimeout=0,
                )
            if matched:
                return body
        time.sleep(2)
    raise TimeoutError("Expected message was not observed before the deadline")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="sa-east-1")
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--other-token-file")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument(
        "--exercise-dlq",
        action="store_true",
        help="Send one poison message; expect about 15-20 minutes and an intentional alarm",
    )
    parser.add_argument("--dlq-timeout", type=int, default=1200)
    parser.add_argument("--report", default=".deploy/live-report.json")
    args = parser.parse_args()
    check(args.timeout > 0 and args.dlq_timeout > 0, "Timeouts must be positive")
    session = boto3.Session(region_name=args.region)
    stack = session.client("cloudformation").describe_stacks(StackName=args.stack_name)[
        "Stacks"
    ][0]
    parameters = {
        p["ParameterKey"]: p.get("ParameterValue") for p in stack["Parameters"]
    }
    check(
        parameters.get("EnvironmentName") == "development",
        "This write-producing test only runs on a development stack",
    )
    outputs = {p["OutputKey"]: p["OutputValue"] for p in stack["Outputs"]}
    base = outputs["ApiBaseUrl"].rstrip("/")
    token = token_file(args.token_file)
    key = str(uuid.uuid4())

    def request(method, path, payload=None, access=token, idempotency=key):
        body = (
            payload
            if isinstance(payload, bytes)
            else json.dumps(payload).encode() if payload is not None else None
        )
        headers = {"Content-Type": "application/json", "Idempotency-Key": idempotency}
        if access:
            headers["Authorization"] = "Bearer " + access
        req = Request(base + path, method=method, data=body, headers=headers)
        try:
            with urlopen(req, timeout=20) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.loads(error.read())

    passed = []
    check(
        request("GET", "/health", access=None)[0] == 200, "Public health check failed"
    )
    check(
        request("GET", "/orders/" + key, access=None)[0] in (401, 403),
        "Order endpoint accepted an unauthenticated request",
    )
    check(
        request("POST", "/orders", b"{malformed")[0] == 400,
        "Malformed JSON did not produce 400",
    )
    payload = {"customerId": "e2e-customer", "productId": "demo-product", "quantity": 2}
    code, original = request("POST", "/orders", payload)
    check(
        code == 201 and original.get("status") == "RECEIVED", f"Create failed: {code}"
    )
    code, replay = request("POST", "/orders", payload)
    check(code == 201 and replay == original, "Idempotent replay changed the response")
    check(
        request("POST", "/orders", {**payload, "quantity": 3})[0] == 409,
        "Conflicting idempotency payload did not produce 409",
    )
    order_id = original["orderId"]
    passed.extend(
        [
            "public_health",
            "authentication_required",
            "malformed_json",
            "create",
            "idempotent_replay",
            "conflict",
        ]
    )
    deadline = time.monotonic() + args.timeout
    while True:
        code, current = request("GET", "/orders/" + order_id)
        if (
            code == 200
            and current.get("status") == "PROCESSED"
            and current.get("processedAt")
        ):
            break
        check(
            time.monotonic() < deadline, "Order did not reach PROCESSED before timeout"
        )
        time.sleep(2)
    ticket = (
        session.resource("dynamodb")
        .Table(outputs["FulfillmentsTable"])
        .get_item(Key={"orderId": order_id}, ConsistentRead=True)
        .get("Item")
    )
    check(
        ticket
        and ticket["status"] == "READY_FOR_FULFILLMENT"
        and ticket["quantity"] == 2,
        "Durable fulfillment ticket is missing",
    )
    passed.extend(["asynchronous_processing", "get_processed", "durable_fulfillment"])
    if args.other_token_file:
        check(
            request(
                "GET", "/orders/" + order_id, access=token_file(args.other_token_file)
            )[0]
            == 404,
            "Cross-owner order access was allowed",
        )
        passed.append("owner_isolation")
    sqs = session.client("sqs")
    notification = wait_for_message(
        sqs,
        outputs["NotificationAuditQueueUrl"],
        lambda m: m.get("orderId") == order_id
        and m.get("eventId") == f"OrderNotificationRequested:{order_id}",
        args.timeout,
    )
    check(
        notification["fulfillmentId"] == current["fulfillmentId"],
        "Notification correlation failed",
    )
    passed.append("eventbridge_notification_sns_fanout")
    if args.exercise_dlq:
        poison = {"testRunId": key, "invalidOrderId": "intentional-e2e-poison"}
        sent = sqs.send_message_batch(
            QueueUrl=outputs["OrdersQueueUrl"],
            Entries=[
                {"Id": "duplicate", "MessageBody": json.dumps({"orderId": order_id})},
                {"Id": "poison", "MessageBody": json.dumps(poison)},
            ],
        )
        check(not sent.get("Failed"), "SQS rejected the live test batch")
        print(
            "Waiting for managed SQS retries and DLQ delivery; evidence is retained.",
            flush=True,
        )
        wait_for_message(
            sqs,
            outputs["OrdersDeadLetterQueueUrl"],
            lambda m: m.get("testRunId") == key,
            args.dlq_timeout,
        )
        # The 15-minute access token can expire while waiting for managed retries.
        final = (
            session.resource("dynamodb")
            .Table(outputs["OrdersTableName"])
            .get_item(Key={"orderId": order_id}, ConsistentRead=True)["Item"]
        )
        check(
            all(final.get(k) == v for k, v in current.items()),
            "Duplicate delivery changed the final order",
        )
        passed.extend(["duplicate_final_state", "managed_retries_and_dlq"])
    report = {
        "stack": args.stack_name,
        "region": args.region,
        "orderId": order_id,
        "testRunId": key,
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "passed": passed,
        "notRun": ([] if args.other_token_file else ["live_owner_isolation"])
        + ([] if args.exercise_dlq else ["live_dlq"])
        + ["live_canary_rollback"],
    }
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
