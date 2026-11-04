"""Wait for the repository's loopback-only DynamoDB Local service."""

import time
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

client = boto3.client(
    "dynamodb",
    endpoint_url="http://127.0.0.1:18000",
    region_name="us-east-1",
    aws_access_key_id="localTesting",
    aws_secret_access_key="localTesting",
    config=Config(connect_timeout=1, read_timeout=2, retries={"max_attempts": 0}),
)
deadline = time.monotonic() + 60
while True:
    try:
        client.list_tables(Limit=1)
        print("DynamoDB Local is ready.")
        break
    except (BotoCoreError, ClientError):
        if time.monotonic() >= deadline:
            raise
        time.sleep(1)
