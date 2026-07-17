from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from googlechatai._file_state import atomic_write_text
from googlechatai.identity import FileIdentityCache
from googlechatai.queues import FileAsyncResponseQueue
from googlechatai.streaming import FileStreamCancellationRegistry
from googlechatai.token_store import FileTokenStore, TokenRecord
from googlechatai.transport import FileIdempotencyStore
from googlechatai.workspace_events import FileWorkspaceEventsCheckpointStore


class FileStateConcurrencyTests(unittest.TestCase):
    def test_atomic_temp_files_are_created_restrictively_before_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            destination = Path(tmpdir) / "private-state.json"
            real_open = os.open
            requested_modes: list[int] = []

            def tracking_open(path, flags, mode=0o777):
                requested_modes.append(mode)
                return real_open(path, flags, mode)

            with patch("googlechatai._file_state.os.open", side_effect=tracking_open):
                atomic_write_text(destination, '{"secret":"not-logged"}')

            self.assertEqual(requested_modes, [0o600])
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_idempotency_claims_are_serialized_for_one_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "claims.json"

            def claim(index: int):
                return FileIdempotencyStore(path).claim(
                    "same-event",
                    ttl_ms=60_000,
                    now_ms=1_000 + index,
                )

            with ThreadPoolExecutor(max_workers=12) as executor:
                claims = list(executor.map(claim, range(12)))

            self.assertEqual(sum(claim.claimed for claim in claims), 1)
            self.assertEqual(sum(claim.duplicate for claim in claims), 11)
            final_claim = FileIdempotencyStore(path).claim(
                "same-event",
                ttl_ms=60_000,
                now_ms=2_000,
            )
            self.assertEqual(final_claim.seen_count, 13)

    def test_queue_and_token_store_keep_distinct_concurrent_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            queue = FileAsyncResponseQueue(base / "queue.json")
            token_store = FileTokenStore(base / "tokens.json")

            def enqueue(index: int) -> None:
                queue.enqueue({"taskId": f"task-{index}"})

            def save(index: int) -> None:
                token_store.save(
                    TokenRecord(
                        principal_id=f"users/{index}",
                        access_token=f"token-{index}",
                    )
                )

            with ThreadPoolExecutor(max_workers=12) as executor:
                list(executor.map(enqueue, range(12)))
                list(executor.map(save, range(12)))

            self.assertEqual(
                sorted(entry["taskId"] for entry in queue.list()),
                sorted(f"task-{index}" for index in range(12)),
            )
            self.assertEqual(
                sorted(token_store.list()),
                sorted(f"users/{index}" for index in range(12)),
            )

    def test_cancellation_identity_and_checkpoint_updates_do_not_lose_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            cancellations = FileStreamCancellationRegistry(base / "cancel.json")
            identities = FileIdentityCache(base / "identities.json")
            checkpoints = FileWorkspaceEventsCheckpointStore(base / "checkpoints.json")

            def write(index: int) -> None:
                cancellations.cancel(f"stream-{index}", "stop")
                identities.put_many(
                    [
                        {
                            "id": str(index),
                            "email": f"person-{index}@example.com",
                            "aliases": [],
                        }
                    ]
                )
                checkpoints.save(
                    f"scope-{index}",
                    {"cursor": f"cursor-{index}"},
                )

            with ThreadPoolExecutor(max_workers=12) as executor:
                list(executor.map(write, range(12)))

            self.assertTrue(all(cancellations.is_cancelled(f"stream-{i}") for i in range(12)))
            self.assertEqual(len(identities.list()), 12)
            self.assertEqual(
                [checkpoints.load(f"scope-{i}") for i in range(12)],
                [{"cursor": f"cursor-{i}"} for i in range(12)],
            )


if __name__ == "__main__":
    unittest.main()
