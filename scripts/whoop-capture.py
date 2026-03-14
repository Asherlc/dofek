"""
mitmproxy addon that captures all WHOOP API requests/responses to a JSON file.

Usage:
    mitmweb --listen-port 8080 -s scripts/whoop-capture.py

Output: scripts/whoop-captured-requests.json (overwritten on each new request)

After capturing, paste the file contents or interesting entries here so
we can add them to the OpenAPI spec and build the sync integration.
"""

import json
import os
from datetime import datetime
from mitmproxy import http

OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "whoop-captured-requests.json")

# Load existing captures if file exists
captured: list[dict] = []
if os.path.exists(OUTPUT_FILE):
    try:
        with open(OUTPUT_FILE) as f:
            captured = json.load(f)
    except (json.JSONDecodeError, IOError):
        captured = []


def response(flow: http.HTTPFlow) -> None:
    """Called for every response passing through the proxy."""
    url = flow.request.pretty_url

    # Only capture WHOOP API calls
    if "api.prod.whoop.com" not in url and "api-7.whoop.com" not in url:
        return

    # Skip known/boring endpoints we've already documented
    skip_prefixes = [
        "/auth-service/",
        "/metrics-service/v1/metrics/",  # HR stream (huge)
    ]
    path = flow.request.path
    if any(path.startswith(p) for p in skip_prefixes):
        return

    # Parse response body
    response_body = None
    content_type = flow.response.headers.get("content-type", "")
    if flow.response.content and "json" in content_type:
        try:
            response_body = json.loads(flow.response.content)
        except json.JSONDecodeError:
            response_body = flow.response.content.decode("utf-8", errors="replace")
    elif flow.response.content:
        response_body = flow.response.content.decode("utf-8", errors="replace")[:2000]

    # Parse request body
    request_body = None
    if flow.request.content:
        try:
            request_body = json.loads(flow.request.content)
        except (json.JSONDecodeError, UnicodeDecodeError):
            request_body = flow.request.content.decode("utf-8", errors="replace")[:1000]

    entry = {
        "timestamp": datetime.now().isoformat(),
        "method": flow.request.method,
        "url": url,
        "path": path,
        "status": flow.response.status_code,
        "request_headers": {
            k: v for k, v in flow.request.headers.items()
            if k.lower() in ("content-type", "x-amz-target", "user-agent", "accept")
        },
        "request_body": request_body,
        "response_headers": {
            k: v for k, v in flow.response.headers.items()
            if k.lower() in ("content-type",)
        },
        "response_body": response_body,
    }

    captured.append(entry)

    # Write to file after each capture
    with open(OUTPUT_FILE, "w") as f:
        json.dump(captured, f, indent=2, default=str)

    # Log to console
    body_preview = ""
    if isinstance(response_body, dict):
        keys = list(response_body.keys())[:5]
        body_preview = f" keys={keys}"
    elif isinstance(response_body, list):
        body_preview = f" [{len(response_body)} items]"

    print(f"📡 {flow.request.method} {path} → {flow.response.status_code}{body_preview}")
