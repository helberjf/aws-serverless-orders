"""Fail closed unless production has a real manual approval gate and main-only rules."""

import argparse
import json
import os
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--environment", choices=["development", "production"], required=True
    )
    args = parser.parse_args()
    if args.environment != "production":
        return
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("Production deployment requires refs/heads/main")
    repository = os.environ["GITHUB_REPOSITORY"]
    token = os.environ["GH_TOKEN"]

    def read(path):
        request = Request(
            f"https://api.github.com/repos/{repository}{path}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    for name in ["production-plan", "production"]:
        environment = read("/environments/" + name)
        if not (environment.get("deployment_branch_policy") or {}).get(
            "custom_branch_policies"
        ):
            raise RuntimeError(f"{name} requires an explicit main branch rule")
        rules = read("/environments/" + name + "/deployment-branch-policies")[
            "branch_policies"
        ]
        if (
            len(rules) != 1
            or rules[0]["name"] != "main"
            or rules[0].get("type", "branch") != "branch"
        ):
            raise RuntimeError(f"{name} must allow only the main branch, without tags")
        if name == "production":
            reviewers = [
                r
                for r in environment["protection_rules"]
                if r["type"] == "required_reviewers" and r.get("reviewers")
            ]
            if not reviewers or environment.get("can_admins_bypass", True):
                raise RuntimeError(
                    "Production requires reviewers and disabled administrator bypass"
                )
    print("Production review gate and branch restrictions verified.")


if __name__ == "__main__":
    main()
