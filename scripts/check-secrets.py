"""Small deterministic credential check; complements review and dependency auditing."""

from pathlib import Path
import re
import subprocess

patterns = [
    re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(rb"-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----"),
    re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
]
files = subprocess.run(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    check=True,
    capture_output=True,
).stdout.split(b"\0")
failures = []
for filename in set(files):
    if not filename:
        continue
    path = Path(filename.decode("utf-8"))
    if path.is_file() and any(
        pattern.search(path.read_bytes()) for pattern in patterns
    ):
        failures.append(str(path))
if failures:
    # Print filenames only, never the suspected credential itself.
    raise SystemExit("Potential credentials found in: " + ", ".join(sorted(failures)))
print(
    "Credential pattern check passed. This is not a guarantee that every secret format is detected."
)
