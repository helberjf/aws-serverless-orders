"""Render the immutable review artifact in the GitHub job summary."""

import os
from pathlib import Path

review = Path(".deploy/review.json").read_text()
with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
    summary.write(
        "Review this exact change set before approving deployment.\n\n```json\n"
        + review
        + "\n```\n"
    )
