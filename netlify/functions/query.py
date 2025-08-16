# netlify/functions/query.py
# Netlify Function endpoint: /.netlify/functions/query
#
# Security: This code DOES NOT contain any secrets. Put your token into Netlify env vars:
#   LEAK_API_TOKEN
#   ALLOWED_ORIGINS  (optional, comma-separated origins)
#
# Usage (POST JSON):
#   { "query": "917470558969", "limit": 100, "lang": "en", "type": "json" }

import os
import json
import textwrap
import requests

API_URL = "https://leakosintapi.com/"

def make_response(status_code: int, body_obj: dict, origin: str = None):
    """Return Netlify-compatible lambda response with CORS headers."""
    headers = {
        "Content-Type": "application/json"
    }
    # Allow explicit origin if provided; otherwise allow all (use ALLOWED_ORIGINS for production)
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
    else:
        headers["Access-Control-Allow-Origin"] = "*"
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body_obj, ensure_ascii=False)
    }

def summarize(resp_json):
    """Create a short human-readable summary from the expected response structure."""
    if not isinstance(resp_json, dict):
        return textwrap.shorten(str(resp_json), width=2000, placeholder="…")

    # Upstream error case
    if "Error code" in resp_json:
        err = resp_json.get("Error code")
        msg = resp_json.get("Description") or resp_json.get("message") or ""
        return f"API Error: {err}. {msg}"

    # Typical response path: "List" -> DB sections -> Data arrays
    if "List" in resp_json and isinstance(resp_json["List"], dict):
        parts = []
        for dbname, dbinfo in resp_json["List"].items():
            parts.append(f"== {dbname} ==")
            info_leak = dbinfo.get("InfoLeak") or dbinfo.get("info") or ""
            if info_leak:
                parts.append(f"Summary: {info_leak}")
            data = dbinfo.get("Data") or []
            parts.append(f"Entries: {len(data)}")
            # show up to 3 entries
            for i, entry in enumerate(data[:3], 1):
                parts.append(f" Entry {i}:")
                if isinstance(entry, dict):
                    for k, v in entry.items():
                        s = str(v)
                        if len(s) > 200:
                            s = s[:200] + "…"
                        parts.append(f"  {k}: {s}")
                else:
                    parts.append(f"  {str(entry)}")
            if len(data) > 3:
                parts.append(f"...and {len(data)-3} more entries")
            parts.append("")  # blank line between DBs
        return "\n".join(parts).strip()

    # fallback
    return textwrap.shorten(str(resp_json), width=2000, placeholder="…")

def handler(event, context):
    try:
        # Preflight CORS support
        if event.get("httpMethod") == "OPTIONS":
            return make_response(200, {"ok": True})

        # Allowed origin for CORS (optional). Set ALLOWED_ORIGINS in Netlify env to restrict.
        allowed_origins = os.getenv("ALLOWED_ORIGINS", "").strip()
        allowed_origin = None
        if allowed_origins:
            # take first origin if multiple provided
            allowed_origin = allowed_origins.split(",")[0].strip()

        # Get token from environment (must be set in Netlify site settings)
        token = os.getenv("LEAK_API_TOKEN")
        if not token:
            return make_response(500, {"error": "Server misconfiguration: missing LEAK_API_TOKEN"}, allowed_origin)

        # Parse body
        raw_body = event.get("body") or ""
        try:
            payload = json.loads(raw_body)
        except Exception:
            return make_response(400, {"error": "Invalid JSON. Expected application/json with 'query' field."}, allowed_origin)

        query = payload.get("query") or payload.get("request")
        if not query:
            return make_response(400, {"error": "Missing 'query' field in request body."}, allowed_origin)

        # Build upstream payload
        limit = int(payload.get("limit", 100))
        lang = payload.get("lang", "en")
        out_type = payload.get("type", "json")

        upstream_payload = {
            "token": token,
            "request": str(query),
            "limit": limit,
            "lang": lang,
            "type": out_type
        }

        # Call upstream API
        try:
            resp = requests.post(API_URL, json=upstream_payload, timeout=30)
        except requests.RequestException as e:
            return make_response(502, {"error": "Upstream request failed", "detail": str(e)}, allowed_origin)

        if not resp.ok:
            # Keep error info minimal; avoid leaking headers/token content
            text = resp.text
            truncated = text if len(text) <= 1000 else text[:1000] + "…"
            return make_response(502, {"error": "Upstream returned non-200", "status_code": resp.status_code, "text": truncated}, allowed_origin)

        try:
            resp_json = resp.json()
        except Exception:
            # upstream returned non-JSON
            raw_text = resp.text
            return make_response(200, {"raw": raw_text, "summary": textwrap.shorten(raw_text, width=2000)}, allowed_origin)

        # Build summary and return both raw and summary
        summary = summarize(resp_json)
        return make_response(200, {"raw": resp_json, "summary": summary}, allowed_origin)

    except Exception as e:
        # Catch-all for any unhandled errors, always return valid JSON
        return make_response(
            500,
            {"error": "Internal server error", "detail": str(e)},
            os.getenv("ALLOWED_ORIGINS", "").split(",")[0].strip() if os.getenv("ALLOWED_ORIGINS", "").strip() else "*"
        )
