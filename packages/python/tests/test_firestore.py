from __future__ import annotations

from copy import deepcopy
import unittest
from typing import Any
from urllib.parse import parse_qs, urlparse

from googlechatai.firestore import FirestoreIdempotencyStore, FirestoreIdempotencyStoreError


class FakeFirestore:
    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {}
        self.requests: list[dict[str, Any]] = []
        self.revision = 0

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(deepcopy(request))
        parsed = urlparse(str(request["url"]))
        query = parse_qs(parsed.query)
        path = parsed.path
        method = request["method"]

        if method == "POST":
            document_id = query.get("documentId", [None])[0]
            document_path = f"{path}/{document_id}"
            if not document_id or document_path in self.documents:
                return {"status": 409}
            self.revision += 1
            document = {
                "fields": deepcopy(request["body"]["fields"]),
                "updateTime": f"revision-{self.revision}",
            }
            self.documents[document_path] = document
            return {"status": 200, "json": deepcopy(document)}

        current = self.documents.get(path)
        if method == "GET":
            return {"status": 200, "json": deepcopy(current)} if current else {"status": 404}
        if current is None:
            return {"status": 404}
        if query.get("currentDocument.updateTime", [None])[0] != current["updateTime"]:
            return {"status": 409}
        if method == "DELETE":
            del self.documents[path]
            return {"status": 200}

        self.revision += 1
        current["fields"].update(deepcopy(request["body"]["fields"]))
        current["updateTime"] = f"revision-{self.revision}"
        return {"status": 200, "json": deepcopy(current)}


class FirestoreIdempotencyStoreTests(unittest.TestCase):
    def test_conditional_create_and_update_time_cas_preserve_duplicate_claims(self) -> None:
        firestore = FakeFirestore()
        store = FirestoreIdempotencyStore(
            project_id="demo-project",
            collection_path="chatIdempotency",
            request=firestore,
        )

        first = store.claim(
            "event/with/private-looking-value",
            ttl_ms=100,
            now_ms=1_000,
            metadata={"eventKind": "message.created"},
        )
        duplicate = store.claim(
            "event/with/private-looking-value",
            ttl_ms=100,
            now_ms=1_050,
        )

        self.assertTrue(first.claimed)
        self.assertFalse(first.duplicate)
        self.assertEqual(duplicate.seen_count, 2)
        self.assertTrue(duplicate.duplicate)
        self.assertEqual(duplicate.metadata, {"eventKind": "message.created"})
        self.assertNotIn("event/with/private-looking-value", firestore.requests[0]["url"])
        self.assertTrue(any(request["method"] == "PATCH" for request in firestore.requests))

    def test_expired_claim_is_precondition_deleted_then_recreated(self) -> None:
        firestore = FakeFirestore()
        store = FirestoreIdempotencyStore(
            project_id="demo-project",
            collection_path="chatIdempotency",
            request=firestore,
        )

        store.claim("event-1", ttl_ms=100, now_ms=1_000)
        after_expiry = store.claim("event-1", ttl_ms=100, now_ms=1_100)

        self.assertTrue(after_expiry.claimed)
        self.assertEqual(after_expiry.seen_count, 1)
        self.assertTrue(any(request["method"] == "DELETE" for request in firestore.requests))

    def test_retries_canonical_failed_precondition_during_cas(self) -> None:
        firestore = FakeFirestore()
        reject_first_patch = True

        def request(input_value: dict[str, Any]) -> dict[str, Any]:
            nonlocal reject_first_patch
            if input_value["method"] == "PATCH" and reject_first_patch:
                reject_first_patch = False
                return {"status": 400, "json": {"error": {"status": "FAILED_PRECONDITION"}}}
            return firestore(input_value)

        store = FirestoreIdempotencyStore(
            project_id="demo-project",
            collection_path="chatIdempotency",
            request=request,
            cas_retry_base_delay_ms=0,
        )
        store.claim("event-1", now_ms=1_000)
        duplicate = store.claim("event-1", now_ms=1_050)

        self.assertTrue(duplicate.duplicate)
        self.assertEqual(duplicate.seen_count, 2)
        self.assertEqual(
            sum(request["method"] == "PATCH" for request in firestore.requests),
            1,
        )

    def test_fails_after_bounded_repeated_precondition_conflicts(self) -> None:
        firestore = FakeFirestore()

        def request(input_value: dict[str, Any]) -> dict[str, Any]:
            if input_value["method"] == "PATCH":
                return {"status": 400, "json": {"error": {"status": "FAILED_PRECONDITION"}}}
            return firestore(input_value)

        store = FirestoreIdempotencyStore(
            project_id="demo-project",
            collection_path="chatIdempotency",
            request=request,
            max_cas_attempts=2,
            cas_retry_base_delay_ms=0,
        )
        store.claim("event-1", now_ms=1_000)
        with self.assertRaises(FirestoreIdempotencyStoreError) as raised:
            store.claim("event-1", now_ms=1_050)
        self.assertEqual(raised.exception.status, 409)

    def test_validates_collection_path_and_transport(self) -> None:
        with self.assertRaisesRegex(TypeError, "collection_path"):
            FirestoreIdempotencyStore(
                project_id="demo-project",
                collection_path="collection/document",
                request=lambda _: {"status": 200},
            )
        with self.assertRaisesRegex(TypeError, "request transport"):
            FirestoreIdempotencyStore(
                project_id="demo-project",
                collection_path="claims",
                request=None,  # type: ignore[arg-type]
            )


if __name__ == "__main__":
    unittest.main()
