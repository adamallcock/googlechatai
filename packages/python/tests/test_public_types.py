"""Runtime coverage for the public Python typing module."""

from __future__ import annotations

import unittest

from googlechatai import InMemoryIdempotencyStore, project_model_context, public_types


class PublicTypesTests(unittest.TestCase):
    def test_public_contract_module_exports_stable_models_and_protocols(self) -> None:
        self.assertEqual(
            set(public_types.__all__),
            {
                "ChatEventEnvelope",
                "ChatMessage",
                "ChatSpace",
                "ChatThread",
                "ChatUser",
                "IdentityAccess",
                "IdempotencyClaim",
                "IdempotencyStore",
                "ModelContextFragment",
                "ModelContextProjection",
                "ModelContextProjectionState",
                "ModelContextProjector",
                "ModelContextSourceState",
                "TrustLevel",
            },
        )
        self.assertTrue(hasattr(public_types.IdempotencyStore, "claim"))
        self.assertTrue(hasattr(public_types.ModelContextProjector, "__call__"))

    def test_public_contracts_match_runtime_claim_and_model_projection(self) -> None:
        store = InMemoryIdempotencyStore()
        claim = store.claim("event-1", now_ms=1_000)
        projection = project_model_context(
            {"kind": "chat.context", "messages": [{"text": "Hello from Chat."}]}
        )

        self.assertIsInstance(claim, public_types.IdempotencyClaim)
        self.assertTrue(isinstance(store, public_types.IdempotencyStore))
        self.assertTrue(claim.claimed)
        self.assertFalse(claim.duplicate)
        self.assertEqual(projection["kind"], "chat.model_context")
        self.assertEqual(projection["schemaVersion"], 1)
        self.assertIn("projection", projection)
        self.assertEqual(projection["fragments"][0]["type"], "system_policy")
        self.assertNotIn("role", projection["fragments"][0])
