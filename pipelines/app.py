"""FastAPI entrypoint for the Base Power Zeus pipelines app (Vercel project
`base-power-zeus-pipelines`, Python runtime). Vercel's Python builder
detects the `app` object below as the ASGI app for this project.

Auto-registers /cron/<name> for every module in pipelines/sources/ (see
pipelines/pipelines/core/registry.py for the source-module contract).
Every /cron/<anything> request is checked against CRON_SECRET *in ASGI
middleware*, which runs before Starlette's router ever matches a path —
so a request with a missing/wrong bearer token gets 401 even for a name
that doesn't exist yet, never a 404 (which would leak which sources are
registered). Only once auth passes does a 404 mean "no such source".
"""
from __future__ import annotations

import hmac
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from pipelines.core import registry

CRON_PREFIX = "/cron"


class CronAuthMiddleware:
    """Pure ASGI middleware: rejects any /cron or /cron/<name> request
    without `Authorization: Bearer $CRON_SECRET` with 401, before request
    reaches routing. Fails closed if CRON_SECRET is unset or empty, so an
    unconfigured deployment never accidentally allows an unauthenticated
    request through.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path == CRON_PREFIX or path.startswith(CRON_PREFIX + "/"):
            import os

            expected = os.environ.get("CRON_SECRET") or ""
            headers = dict(scope.get("headers") or [])
            auth = headers.get(b"authorization", b"").decode("latin-1")
            provided = auth[len("Bearer ") :] if auth.startswith("Bearer ") else ""

            if not expected or not provided or not hmac.compare_digest(provided, expected):
                response = JSONResponse(
                    {"detail": "unauthorized"},
                    status_code=401,
                )
                await response(scope, receive, send)
                return

        await self.app(scope, receive, send)


app = FastAPI(title="base-power-zeus-pipelines")
app.add_middleware(CronAuthMiddleware)


@app.get("/")
def health() -> dict:
    return {"status": "ok", "service": "base-power-zeus-pipelines"}


@app.api_route(CRON_PREFIX + "/{name}", methods=["GET", "POST"])
async def run_cron(name: str, request: Request) -> JSONResponse:
    """Run one source's pipeline. Auth already passed (CronAuthMiddleware
    ran first) by the time this handler executes. 404 means the name has
    no pipelines/sources/<name>.py module registered."""
    module = registry.load_source(name)
    if module is None:
        return JSONResponse({"detail": "not found", "source": name}, status_code=404)

    run_fn = getattr(module, "run", None)
    if run_fn is None:
        return JSONResponse(
            {"detail": f"source module {name!r} has no run()"}, status_code=500
        )

    run_fn(runner="cron")
    return JSONResponse(
        {"status": "ok", "source": name, "ran_at": datetime.now(timezone.utc).isoformat()}
    )
