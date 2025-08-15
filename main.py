# main.py
import os
import textwrap
import requests
from typing import Any, Dict, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware

API_URL = "https://leakosintapi.com/"
API_TOKEN = os.getenv("LEAK_API_TOKEN")  # <-- set this on Render (Secrets)
if not API_TOKEN:
    raise RuntimeError("LEAK_API_TOKEN environment variable is required on the server.")

# ALLOWED_ORIGINS: comma-separated list of origins allowed to call this API (e.g. https://your-pages-domain.pages.dev)
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "")

app = FastAPI(title="LeakOS Wrapper API")

# Configure CORS from env var
origins = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]
if origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


class QueryPayload(BaseModel):
    query: str
    limit: int = 100
    lang: str = "en"
    type: str = "json"


def call_leak_api(query: str, limit: int = 100, lang: str = "en", out_type: str = "json") -> Dict[str, Any]:
    payload = {
        "token": API_TOKEN,
        "request": query,
        "limit": limit,
        "lang": lang,
        "type": out_type,
    }
    resp = requests.post(API_URL, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()


def summarize(resp_json: Any) -> str:
    """Generate a short human-readable summary from the API response."""
    if not isinstance(resp_json, dict):
        return textwrap.shorten(str(resp_json), width=2000, placeholder="…")

    # API-level error
    if "Error code" in resp_json:
        err = resp_json.get("Error code")
        msg = resp_json.get("Description") or resp_json.get("message") or ""
        return f"API error: {err}. {msg}"

    # The docs show a "List" object containing databases with "Data" lists
    if "List" in resp_json and isinstance(resp_json["List"], dict):
        parts = []
        for dbname, dbinfo in resp_json["List"].items():
            parts.append(f"== {dbname} ==")
            info_leak = dbinfo.get("InfoLeak") or dbinfo.get("info") or ""
            if info_leak:
                parts.append(f"Summary: {info_leak}")
            data = dbinfo.get("Data") or []
            parts.append(f"Entries: {len(data)}")
            # show up to first 3 entries
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

    # fallback: pretty string of response
    return textwrap.shorten(str(resp_json), width=2000, placeholder="…")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/query")
def query(payload: QueryPayload):
    """Accepts JSON {query, limit, lang, type} and returns {raw, summary}."""
    try:
        raw = call_leak_api(payload.query, payload.limit, payload.lang, payload.type)
    except requests.HTTPError as he:
        # upstream returned 4xx/5xx
        raise HTTPException(status_code=502, detail=f"Upstream HTTP error: {he}")
    except requests.RequestException as re:
        raise HTTPException(status_code=502, detail=f"Upstream request failed: {re}")

    summary = summarize(raw)
    return {"raw": raw, "summary": summary}
