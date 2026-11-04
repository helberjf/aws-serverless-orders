"""Create one order through the deployed IAM API and verify asynchronous processing."""

import argparse
import json
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", default="aws-serverless-orders")
    parser.add_argument("--region", default="sa-east-1")
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    session = boto3.Session(region_name=args.region)
    stack = session.client("cloudformation").describe_stacks(StackName=args.stack_name)["Stacks"][0]
    outputs = {entry["OutputKey"]: entry["OutputValue"] for entry in stack["Outputs"]}
    endpoint = outputs["OrdersApi"].rstrip("/")
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError("Configure AWS credentials before running this live test")

    def request(method, url, payload=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"}
        signed = AWSRequest(method=method, url=url, data=body, headers=headers)
        SigV4Auth(credentials.get_frozen_credentials(), "execute-api", args.region).add_auth(signed)
        prepared = Request(url, data=body, headers=dict(signed.headers.items()), method=method)
        try:
            with urlopen(prepared, timeout=15) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            raise RuntimeError(f"API returned HTTP {error.code}: {error.read().decode('utf-8')}") from error

    code, order = request("POST", endpoint, {"customerId": "smoke-test", "productId": "demo-product", "quantity": 1})
    if code != 201 or order.get("status") != "RECEIVED":
        raise RuntimeError(f"Unexpected create response: {code} {order}")
    order_id = order["orderId"]
    print(f"Created order {order_id}. Waiting for processing...", flush=True)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        code, current = request("GET", f"{endpoint}/{order_id}")
        if code == 200 and current.get("status") == "PROCESSED" and current.get("processedAt"):
            print(json.dumps(current, indent=2))
            print("PASS: API -> DynamoDB Streams -> SQS -> processor -> status lookup")
            return
        time.sleep(2)
    raise TimeoutError(f"Order {order_id} was not processed within {args.timeout:g}s; see docs/operations.md")


if __name__ == "__main__":
    main()
