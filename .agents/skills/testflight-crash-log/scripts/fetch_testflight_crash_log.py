#!/usr/bin/env python3
"""Fetch TestFlight crash submissions and crash logs via App Store Connect API.

Auth source:
- APP_STORE_CONNECT_KEY_ID
- APP_STORE_CONNECT_ISSUER_ID
- APP_STORE_CONNECT_KEY_BASE64

All secrets are read from Infisical (`infisical secrets get ... --plain`).
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

API_BASE = "https://api.appstoreconnect.apple.com"


@dataclass
class Secrets:
    key_id: str
    issuer_id: str
    private_key_pem: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-id", default="com.dofek.app", help="App bundle ID")
    parser.add_argument("--env", default="prod", help="Infisical environment")
    parser.add_argument("--limit", type=int, default=10, help="Max crash submissions to list")
    parser.add_argument(
        "--build-limit",
        type=int,
        default=8,
        help="Max recent builds to inspect for beta usage metrics",
    )
    parser.add_argument(
        "--submission-id",
        default=None,
        help="Specific betaFeedbackCrashSubmission ID to fetch (defaults to latest)",
    )
    parser.add_argument(
        "--log-lines",
        type=int,
        default=80,
        help="Number of crash log lines to print",
    )
    parser.add_argument(
        "--save-log",
        default=None,
        help="Optional path to save full crash log text",
    )
    parser.add_argument(
        "--skip-build-metrics",
        action="store_true",
        help="Skip /metrics/betaBuildUsages calls",
    )
    return parser.parse_args()


def infisical_get(key: str, env: str) -> str:
    command = ["infisical", "secrets", "get", key, f"--env={env}", "--plain"]
    try:
        output = subprocess.check_output(command, text=True, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip() or error.output.strip() or str(error)
        raise RuntimeError(f"Failed to read secret {key}: {message}") from error
    return output.strip()


def load_secrets(env: str) -> Secrets:
    key_id = infisical_get("APP_STORE_CONNECT_KEY_ID", env)
    issuer_id = infisical_get("APP_STORE_CONNECT_ISSUER_ID", env)
    key_base64 = infisical_get("APP_STORE_CONNECT_KEY_BASE64", env)
    try:
        private_key_pem = base64.b64decode(key_base64).decode("utf-8")
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("APP_STORE_CONNECT_KEY_BASE64 is not valid base64") from error
    if "BEGIN PRIVATE KEY" not in private_key_pem:
        raise RuntimeError("Decoded APP_STORE_CONNECT_KEY_BASE64 is not a PEM private key")
    return Secrets(key_id=key_id, issuer_id=issuer_id, private_key_pem=private_key_pem)


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def make_token(secrets: Secrets) -> str:
    now = int(time.time())
    header = {"alg": "ES256", "kid": secrets.key_id, "typ": "JWT"}
    payload = {
        "iss": secrets.issuer_id,
        "iat": now,
        "exp": now + 1200,
        "aud": "appstoreconnect-v1",
    }

    header_part = b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_part = b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_part}.{payload_part}".encode("ascii")

    private_key = serialization.load_pem_private_key(
        secrets.private_key_pem.encode("utf-8"), password=None
    )
    der_signature = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r_value, s_value = decode_dss_signature(der_signature)
    raw_signature = r_value.to_bytes(32, "big") + s_value.to_bytes(32, "big")
    signature_part = b64url(raw_signature)

    return f"{header_part}.{payload_part}.{signature_part}"


def api_get(path: str, token: str, query: dict[str, str] | None = None) -> dict[str, Any]:
    query_suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
    url = f"{API_BASE}{path}{query_suffix}"

    request = urllib.request.Request(url)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GET {path} failed ({error.code}): {response_body}") from error


def get_app(bundle_id: str, token: str) -> tuple[str, str]:
    response = api_get(
        "/v1/apps",
        token,
        {
            "filter[bundleId]": bundle_id,
            "fields[apps]": "name,bundleId",
            "limit": "5",
        },
    )
    apps = response.get("data", [])
    if not apps:
        raise RuntimeError(f"No App Store Connect app found for bundle id {bundle_id}")
    app = apps[0]
    return app["id"], app.get("attributes", {}).get("name", "unknown")


def list_crashes(app_id: str, token: str, limit: int) -> list[dict[str, Any]]:
    response = api_get(
        f"/v1/apps/{app_id}/betaFeedbackCrashSubmissions",
        token,
        {
            "sort": "-createdDate",
            "limit": str(limit),
            "fields[betaFeedbackCrashSubmissions]": "createdDate,deviceModel,osVersion,buildBundleId,appPlatform",
        },
    )
    return response.get("data", [])


def list_recent_builds(app_id: str, token: str, limit: int) -> list[dict[str, Any]]:
    response = api_get(
        "/v1/builds",
        token,
        {
            "filter[app]": app_id,
            "sort": "-uploadedDate",
            "limit": str(limit),
            "fields[builds]": "version,uploadedDate,processingState,expired",
        },
    )
    return response.get("data", [])


def read_beta_build_usage(build_id: str, token: str) -> dict[str, int | None]:
    response = api_get(f"/v1/builds/{build_id}/metrics/betaBuildUsages", token)
    metric_rows = response.get("data", [])
    if not metric_rows:
        return {
            "installCount": None,
            "sessionCount": None,
            "crashCount": None,
            "feedbackCount": None,
            "inviteCount": None,
        }

    points = metric_rows[0].get("dataPoints", [])
    if not points:
        return {
            "installCount": None,
            "sessionCount": None,
            "crashCount": None,
            "feedbackCount": None,
            "inviteCount": None,
        }

    values = points[0].get("values", {})
    return {
        "installCount": values.get("installCount"),
        "sessionCount": values.get("sessionCount"),
        "crashCount": values.get("crashCount"),
        "feedbackCount": values.get("feedbackCount"),
        "inviteCount": values.get("inviteCount"),
    }


def read_crash_log(submission_id: str, token: str) -> str:
    response = api_get(
        f"/v1/betaFeedbackCrashSubmissions/{submission_id}/crashLog",
        token,
        {"fields[betaCrashLogs]": "logText"},
    )
    return response.get("data", {}).get("attributes", {}).get("logText", "")


def first_matching_line(log_text: str, prefix: str) -> str:
    for line in log_text.splitlines():
        if line.startswith(prefix):
            return line
    return ""


def main() -> int:
    args = parse_args()

    secrets = load_secrets(args.env)
    token = make_token(secrets)

    app_id, app_name = get_app(args.bundle_id, token)
    print(f"App: {app_name} ({args.bundle_id})")
    print(f"App ID: {app_id}")

    if not args.skip_build_metrics:
        builds = list_recent_builds(app_id, token, args.build_limit)
        print(f"Recent builds: {len(builds)}")
        for build in builds:
            attributes = build.get("attributes", {})
            usage = read_beta_build_usage(build["id"], token)
            print(
                "Build "
                f"version={attributes.get('version')} "
                f"uploaded={attributes.get('uploadedDate')} "
                f"state={attributes.get('processingState')} "
                f"installs={usage.get('installCount')} "
                f"sessions={usage.get('sessionCount')} "
                f"crashes={usage.get('crashCount')} "
                f"feedback={usage.get('feedbackCount')}"
            )
        print(
            "Note: beta build usage metrics are authoritative for installs/sessions/crash counts; "
            "betaFeedbackCrashSubmissions below are feedback-linked crash reports only."
        )

    submissions = list_crashes(app_id, token, args.limit)
    print(f"Crash submissions: {len(submissions)}")
    if not submissions:
        return 0

    for index, submission in enumerate(submissions, start=1):
        attrs = submission.get("attributes", {})
        print(
            f"[{index}] id={submission.get('id')}"
            f" created={attrs.get('createdDate')}"
            f" device={attrs.get('deviceModel')}"
            f" os={attrs.get('osVersion')}"
        )

    submission_id = args.submission_id or submissions[0]["id"]
    print(f"Selected submission: {submission_id}")

    log_text = read_crash_log(submission_id, token)
    if not log_text:
        print("No crash log text available for this submission.")
        return 0

    if args.save_log:
        with open(args.save_log, "w", encoding="utf-8") as output_file:
            output_file.write(log_text)
        print(f"Saved full crash log to: {args.save_log}")

    exception_line = first_matching_line(log_text, "Exception Type:")
    termination_line = first_matching_line(log_text, "Termination Reason:")
    print("Summary:")
    if exception_line:
        print(exception_line)
    if termination_line:
        print(termination_line)

    print("Crash log head:")
    for line in log_text.splitlines()[: args.log_lines]:
        print(line)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
