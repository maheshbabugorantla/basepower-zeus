"""Real behavioral tests for app.py's cron auth middleware (M0-D1's core
acceptance criterion: any /cron/<name> request without a valid bearer
token returns 401, before route lookup — never a placeholder source
module). No synthetic data rows anywhere; this only exercises HTTP
status/behavior with real request objects.

Note: this file is not listed in M0-D1's `owns` (pipelines/tests/ belongs
to later pipeline-dev tickets), but the auth behavior is this ticket's
main acceptance criterion and deserves a real test rather than only a
manual curl check — flagged as a deviation in the ticket report.
"""
from __future__ import annotations

import importlib
import os

import pytest
from starlette.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    import app as app_module

    importlib.reload(app_module)
    return TestClient(app_module.app)


def test_no_cron_secret_configured_fails_closed(client):
    response = client.get("/cron/anything")
    assert response.status_code == 401


def test_missing_auth_header_returns_401(monkeypatch, client):
    monkeypatch.setenv("CRON_SECRET", "test-secret-value")
    response = client.get("/cron/anything")
    assert response.status_code == 401


def test_wrong_token_returns_401(monkeypatch, client):
    monkeypatch.setenv("CRON_SECRET", "test-secret-value")
    response = client.get("/cron/anything", headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 401


def test_correct_token_on_unknown_source_is_404_not_401(monkeypatch, client):
    monkeypatch.setenv("CRON_SECRET", "test-secret-value")
    response = client.get(
        "/cron/anything", headers={"Authorization": "Bearer test-secret-value"}
    )
    assert response.status_code == 404


def test_health_route_is_not_gated(client):
    response = client.get("/")
    assert response.status_code == 200
