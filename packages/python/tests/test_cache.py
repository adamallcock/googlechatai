import tempfile
import unittest
from pathlib import Path

from googlechatai import (
    FileArtifactCache,
    InMemoryArtifactCache,
    build_artifact_cache_key,
    build_negative_cache_entry,
    hash_bytes,
)


class ArtifactCacheTests(unittest.TestCase):
    def test_builds_stable_cache_keys(self) -> None:
        key = build_artifact_cache_key(
            namespace="transcription",
            source_id="spaces/AAA/messages/one/attachments/audio",
            bytes_value=b"hello",
            processor={
                "name": "openai",
                "version": "gpt-4o-transcribe",
                "options": {"language": "en"},
            },
        )

        self.assertEqual(
            hash_bytes(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        self.assertEqual(
            key,
            {
                "namespace": "transcription",
                "key": "transcription:efca25bff89fe5098d67c3f65f71a1d8a9e6334203f3d1f7df3cc154e5d8ebe7",
                "contentSha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                "processorHash": "640f3cd1034aa40b1b633626f8529deaba96cdca1cd9fa4470deaa8def8d751b",
                "sizeBytes": 5,
            },
        )

    def test_memory_and_file_cache_hits(self) -> None:
        key = build_artifact_cache_key(
            namespace="attachment",
            source_id="spaces/AAA/messages/one/attachments/report",
            bytes_value="report text",
        )
        memory = InMemoryArtifactCache()
        memory.put(
            key=key["key"],
            bytes_value="report text",
            metadata={
                "contentType": "text/plain",
                "sourceId": "spaces/AAA/messages/one/attachments/report",
            },
            now_ms=1_000,
            ttl_ms=60_000,
        )

        self.assertEqual(
            memory.get(key["key"], now_ms=2_000)["text"],
            "report text",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            disk = FileArtifactCache(Path(tmpdir))
            disk.put(
                key=key["key"],
                bytes_value="report text",
                metadata={"contentType": "text/plain"},
                now_ms=1_000,
                ttl_ms=60_000,
            )

            self.assertEqual(
                FileArtifactCache(Path(tmpdir)).get(key["key"], now_ms=2_000)["text"],
                "report text",
            )

    def test_negative_cache_entries_expire(self) -> None:
        cache = InMemoryArtifactCache()
        cache.put_negative(
            build_negative_cache_entry(
                key="identity:users/999",
                reason="permission_denied",
                source_id="users/999",
                now_ms=1_000,
                ttl_ms=5_000,
            )
        )

        self.assertEqual(
            cache.get("identity:users/999", now_ms=2_000),
            {
                "hit": True,
                "negative": True,
                "key": "identity:users/999",
                "reason": "permission_denied",
                "sourceId": "users/999",
                "createdAt": "1970-01-01T00:00:01.000Z",
                "expiresAt": "1970-01-01T00:00:06.000Z",
            },
        )
        self.assertEqual(
            cache.get("identity:users/999", now_ms=7_000),
            {"hit": False, "key": "identity:users/999", "reason": "expired"},
        )


if __name__ == "__main__":
    unittest.main()
