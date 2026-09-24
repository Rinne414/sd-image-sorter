"""A missing image file does not flood the launcher console.

A large library with moved files produced one "HTTP 404 on GET
/api/image-thumbnail/..." warning per thumbnail. The gallery already shows a
banner for missing files, so those 404s log at debug; other HTTP errors keep
their warning.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request

import main


def _request(path: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "headers": [],
            "query_string": b"",
        }
    )


def test_missing_thumbnail_and_image_file_log_at_debug():
    missing = HTTPException(status_code=404, detail="Image not found")

    assert (
        main._http_exception_log_level(_request("/api/image-thumbnail/12"), missing)
        == logging.DEBUG
    )
    assert (
        main._http_exception_log_level(_request("/api/image-file/12"), missing)
        == logging.DEBUG
    )


def test_other_http_errors_still_log_as_warnings():
    assert (
        main._http_exception_log_level(
            _request("/api/images/12"), HTTPException(status_code=404)
        )
        == logging.WARNING
    )
    assert (
        main._http_exception_log_level(
            _request("/api/image-file/12"), HTTPException(status_code=500)
        )
        == logging.WARNING
    )


def test_missing_thumbnail_still_answers_404(test_client):
    response = test_client.get("/api/image-thumbnail/987654321")

    assert response.status_code == 404
