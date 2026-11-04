"""Create a development-only Cognito test user without sending an invitation or logging a password."""

import argparse
from getpass import getpass
import boto3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="sa-east-1")
    parser.add_argument("--username", required=True)
    args = parser.parse_args()
    session = boto3.Session(region_name=args.region)
    stack = session.client("cloudformation").describe_stacks(StackName=args.stack_name)[
        "Stacks"
    ][0]
    parameters = {
        p["ParameterKey"]: p.get("ParameterValue") for p in stack["Parameters"]
    }
    if parameters.get("EnvironmentName") != "development":
        raise RuntimeError("This helper only creates users in a development stack")
    pool = next(
        p["OutputValue"]
        for p in stack["Outputs"]
        if p["OutputKey"] == "CognitoUserPoolId"
    )
    password = getpass(
        "Password (12+ characters with upper/lower case, number and symbol): "
    )
    if password != getpass("Repeat password: "):
        raise ValueError("Passwords do not match")
    client = session.client("cognito-idp")
    client.admin_create_user(
        UserPoolId=pool,
        Username=args.username,
        MessageAction="SUPPRESS",
        TemporaryPassword=password,
    )
    client.admin_set_user_password(
        UserPoolId=pool, Username=args.username, Password=password, Permanent=True
    )
    print("Development test user created. No invitation was sent.")


if __name__ == "__main__":
    main()
