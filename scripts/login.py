"""Authenticate with Cognito authorization-code + PKCE; save only a short-lived access token."""

import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
import webbrowser
import boto3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="sa-east-1")
    parser.add_argument("--output", default=".tokens/user.token.json")
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise RuntimeError(
            "Choose a new token filename or remove your expired local token first"
        )
    stack = boto3.client("cloudformation", region_name=args.region).describe_stacks(
        StackName=args.stack_name
    )["Stacks"][0]
    values = {p["OutputKey"]: p["OutputValue"] for p in stack["Outputs"]}
    callback = values["OAuthCallbackUrl"]
    parsed = urlparse(callback)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "localhost"
        or parsed.path != "/callback"
        or not parsed.port
    ):
        raise RuntimeError(
            "This local login helper requires http://localhost:<port>/callback"
        )
    verifier = secrets.token_urlsafe(64)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    state = secrets.token_urlsafe(32)
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            path = urlparse(self.path)
            params = parse_qs(path.query)
            if path.path != "/callback" or not secrets.compare_digest(
                params.get("state", [""])[0], state
            ):
                self.send_error(400, "Invalid OAuth callback")
                return
            if params.get("error"):
                result["error"] = params["error"][0]
            elif params.get("code"):
                result["code"] = params["code"][0]
            else:
                self.send_error(400, "Authorization code missing")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(
                b"Login received. Return to the terminal; you can close this tab."
            )

    auth = (
        values["CognitoDomain"]
        + "/oauth2/authorize?"
        + urlencode(
            {
                "response_type": "code",
                "client_id": values["CognitoClientId"],
                "redirect_uri": callback,
                "scope": "openid orders/read orders/write",
                "code_challenge_method": "S256",
                "code_challenge": challenge,
                "state": state,
                "prompt": "login",
            }
        )
    )
    with HTTPServer(("127.0.0.1", parsed.port), Callback) as server:
        server.timeout = 2
        webbrowser.open(auth)
        print(
            "Complete Cognito sign-in in your browser. Waiting up to five minutes.",
            flush=True,
        )
        deadline = time.monotonic() + 300
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if "code" not in result:
        raise RuntimeError("Cognito login was cancelled, rejected, or timed out")
    body = urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": values["CognitoClientId"],
            "code": result["code"],
            "redirect_uri": callback,
            "code_verifier": verifier,
        }
    ).encode()
    with urlopen(
        Request(
            values["CognitoDomain"] + "/oauth2/token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ),
        timeout=30,
    ) as response:
        tokens = json.load(response)
    saved = {
        "access_token": tokens["access_token"],
        "expires_at": int(time.time()) + tokens["expires_in"],
    }
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(saved, handle)
    print(
        f"Short-lived token saved to {output}; it was not printed. Keep this local file private."
    )


if __name__ == "__main__":
    main()
