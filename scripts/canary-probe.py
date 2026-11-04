"""Observe public health responses during an approved development canary; never modify AWS."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
import boto3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="sa-east-1")
    parser.add_argument("--seconds", type=int, default=720)
    parser.add_argument("--interval", type=float, default=1)
    parser.add_argument("--report", default=".deploy/canary-probe.json")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 1800 or args.interval < 1:
        parser.error("Use 1–1800 seconds and an interval of at least one second")
    stack = boto3.client("cloudformation", region_name=args.region).describe_stacks(
        StackName=args.stack_name
    )["Stacks"][0]
    parameters = {
        p["ParameterKey"]: p.get("ParameterValue") for p in stack["Parameters"]
    }
    if parameters.get("EnvironmentName") != "development":
        raise RuntimeError("The bounded canary probe is limited to development")
    base = next(
        p["OutputValue"] for p in stack["Outputs"] if p["OutputKey"] == "ApiBaseUrl"
    )
    counts = Counter()
    started = datetime.now(timezone.utc).isoformat()
    deadline = time.monotonic() + args.seconds
    next_log = time.monotonic()
    last_status = None
    while time.monotonic() < deadline:
        try:
            with urlopen(base.rstrip("/") + "/health", timeout=10) as response:
                last_status = str(response.status)
        except HTTPError as error:
            last_status = str(error.code)
        except (URLError, TimeoutError):
            last_status = "network_error"
        counts[last_status] += 1
        if time.monotonic() >= next_log:
            print(json.dumps(dict(counts)), flush=True)
            next_log = time.monotonic() + 30
        time.sleep(args.interval)
    report = {
        "stack": args.stack_name,
        "startedAt": started,
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "statusCounts": dict(counts),
        "lastStatus": last_status,
        "note": "Correlate with aliases, alarms and CodeDeploy. HTTP observations alone do not prove rollback.",
    }
    path = Path(args.report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
