import asyncio
import copy
import json
import pathlib
import tempfile
import unittest

from googlechatai.streaming import (
    FileStreamCancellationRegistry,
    InMemoryStreamCancellationRegistry,
    advance_stream_scheduler,
    astream_chat_reply,
    create_stream_scheduler_state,
    replay_stream_scheduler,
    stream_chat_reply,
)

ROOT = pathlib.Path(__file__).resolve().parents[3]

TARGET = {
    "messageName": "spaces/AAA/messages/PLACEHOLDER",
    "space": "spaces/AAA",
    "threadName": "spaces/AAA/threads/TTT",
}


class FakeApplier:
    def __init__(self, respond=None):
        self.respond = respond
        self.calls = []

    def __call__(self, request):
        self.calls.append(dict(request))
        if self.respond is not None:
            result = self.respond(request, len(self.calls) - 1)
        else:
            result = {"ok": True, "status": 200}
        json_body = result.get(
            "json", {"name": f"spaces/AAA/messages/generated-{len(self.calls)}"}
        )
        return {
            "ok": result["ok"],
            "status": result["status"],
            "json": json_body,
            "error": None
            if result["ok"]
            else {"name": "HttpError", "message": f"HTTP {result['status']}"},
        }


class Clock:
    def __init__(self, step=0):
        self.now = 0
        self.step = step

    def __call__(self):
        self.now += self.step
        return self.now


class SchedulerConformanceTest(unittest.TestCase):
    def test_replays_every_shared_scheduler_case(self) -> None:
        cases = json.loads(
            (ROOT / "conformance/cases/stream.scheduler.json").read_text()
        )
        for conformance_case in cases:
            with self.subTest(case=conformance_case["id"]):
                self.assertEqual(
                    replay_stream_scheduler(conformance_case["input"]),
                    conformance_case["expect"],
                )

    def test_rejects_unknown_event_types_and_foreign_state(self) -> None:
        state = create_stream_scheduler_state()
        with self.assertRaises(TypeError):
            advance_stream_scheduler(state, {"type": "nope", "atMs": 0})
        with self.assertRaises(TypeError):
            advance_stream_scheduler({"kind": "wrong"}, {"type": "flush", "atMs": 0})

    def test_rejects_invalid_overflow(self) -> None:
        with self.assertRaises(TypeError):
            create_stream_scheduler_state({"overflow": "wrap"})


class StreamChatReplyTest(unittest.TestCase):
    def test_patches_at_cadence_and_finalizes_exact_text(self) -> None:
        applier = FakeApplier()
        report = stream_chat_reply(
            TARGET,
            ["hello ", "world, this is ", "a streamed reply"],
            apply=applier,
            clock=Clock(step=200),
            min_patch_chars=10,
            min_interval_ms=100,
        )
        self.assertTrue(report["ok"])
        self.assertEqual(
            report["finalText"], "hello world, this is a streamed reply"
        )
        finals = [call for call in applier.calls if call["final"]]
        self.assertEqual(len(finals), 1)
        self.assertEqual(
            finals[0]["body"]["text"], "hello world, this is a streamed reply"
        )
        self.assertEqual(finals[0]["path"], "/v1/spaces/AAA/messages/PLACEHOLDER")
        self.assertGreater(len(applier.calls), 1)
        self.assertEqual(report["patches"], len(applier.calls))

    def test_accepts_placeholder_handles(self) -> None:
        applier = FakeApplier()
        report = stream_chat_reply(
            {
                "kind": "chat.placeholder_response_handle",
                "space": "spaces/AAA",
                "messageName": "spaces/AAA/messages/FROMHANDLE",
                "editable": True,
            },
            ["short answer"],
            apply=applier,
            clock=lambda: 0,
        )
        self.assertTrue(report["ok"])
        self.assertEqual(
            applier.calls[0]["path"], "/v1/spaces/AAA/messages/FROMHANDLE"
        )

    def test_rejects_unhydrated_handles(self) -> None:
        with self.assertRaises(TypeError):
            stream_chat_reply(
                {
                    "kind": "chat.placeholder_response_handle",
                    "space": "spaces/AAA",
                    "messageName": None,
                    "editable": False,
                },
                ["x"],
                apply=FakeApplier(),
            )

    def test_attaches_final_cards(self) -> None:
        applier = FakeApplier()
        cards = [{"cardId": "sources", "card": {}}]
        report = stream_chat_reply(
            TARGET,
            ["answer body"],
            apply=applier,
            clock=lambda: 0,
            final_cards=cards,
        )
        self.assertTrue(report["ok"])
        final = applier.calls[-1]
        self.assertEqual(final["query"]["updateMask"], "text,cardsV2")
        self.assertEqual(final["body"]["cardsV2"], cards)

    def test_creates_continuations_in_split_mode(self) -> None:
        applier = FakeApplier()
        long_text = ("word " * 60).strip()
        report = stream_chat_reply(
            TARGET,
            [long_text],
            apply=applier,
            clock=lambda: 0,
            overflow="split",
            max_message_chars=120,
            min_patch_chars=10,
            min_interval_ms=0,
        )
        self.assertTrue(report["ok"])
        self.assertGreater(len(report["continuations"]), 0)
        creates = [call for call in applier.calls if call["kind"] == "create"]
        self.assertEqual(len(creates), len(report["continuations"]))
        self.assertEqual(
            creates[0]["body"]["thread"], {"name": "spaces/AAA/threads/TTT"}
        )
        self.assertEqual(
            applier.calls[-1]["path"], f"/v1/{report['continuations'][-1]}"
        )

    def test_downgrades_split_without_space(self) -> None:
        applier = FakeApplier()
        report = stream_chat_reply(
            {"messageName": "spaces/AAA/messages/NO-SPACE"},
            ["x" * 500],
            apply=applier,
            clock=lambda: 0,
            overflow="split",
            max_message_chars=120,
        )
        self.assertTrue(report["ok"])
        self.assertTrue(report["truncated"])
        self.assertEqual(report["continuations"], [])
        self.assertTrue(all(call["kind"] == "patch" for call in applier.calls))

    def test_cancels_between_chunks(self) -> None:
        applier = FakeApplier()
        registry = InMemoryStreamCancellationRegistry()
        emitted = []

        def stream():
            emitted.append(1)
            yield "first part of the answer "
            registry.cancel("stream-1", "user pressed stop")
            emitted.append(2)
            yield "second part"

        report = stream_chat_reply(
            TARGET,
            stream(),
            apply=applier,
            clock=lambda: 0,
            should_cancel=lambda: registry.is_cancelled("stream-1"),
        )
        self.assertTrue(report["cancelled"])
        self.assertTrue(report["ok"])
        final = applier.calls[-1]
        self.assertTrue(final["final"])
        self.assertIn("[Stopped at user request.]", final["body"]["text"])

    def test_finalizes_with_error_note_when_stream_raises(self) -> None:
        applier = FakeApplier()

        def failing():
            yield "partial output "
            raise RuntimeError("model exploded")

        report = stream_chat_reply(
            TARGET, failing(), apply=applier, clock=lambda: 0
        )
        self.assertFalse(report["ok"])
        self.assertTrue(report["errored"])
        self.assertEqual(report["failure"]["message"], "model exploded")
        self.assertIn(
            "[Response interrupted by an error.]",
            applier.calls[-1]["body"]["text"],
        )

    def test_degrades_after_patch_failures_but_finalizes(self) -> None:
        applier = FakeApplier(
            respond=lambda request, index: {
                "ok": bool(request["final"]),
                "status": 200 if request["final"] else 429,
            }
        )
        report = stream_chat_reply(
            TARGET,
            ["a" * 30, "b" * 30, "c" * 30, "d" * 30],
            apply=applier,
            clock=Clock(step=1000),
            min_patch_chars=10,
            min_interval_ms=0,
            max_consecutive_patch_failures=2,
        )
        self.assertTrue(report["ok"])
        self.assertTrue(report["degradedToFinalOnly"])
        self.assertIn(
            "degraded_to_final_only_after_patch_failures", report["warnings"]
        )
        non_final = [
            call
            for call in applier.calls
            if call["kind"] == "patch" and not call["final"]
        ]
        self.assertEqual(len(non_final), 2)

    def test_reports_failure_when_final_patch_fails(self) -> None:
        applier = FakeApplier(
            respond=lambda request, index: {
                "ok": not request["final"],
                "status": 500 if request["final"] else 200,
            }
        )
        report = stream_chat_reply(
            TARGET, ["something"], apply=applier, clock=lambda: 0
        )
        self.assertFalse(report["ok"])
        self.assertEqual(report["failure"]["name"], "HttpError")

    def test_resumes_from_state_snapshots(self) -> None:
        states = []
        first_applier = FakeApplier()

        def interrupted():
            yield "the first half of a long answer that keeps going "
            raise RuntimeError("worker restarted")

        first_report = stream_chat_reply(
            TARGET,
            interrupted(),
            apply=first_applier,
            clock=Clock(step=500),
            min_patch_chars=10,
            min_interval_ms=0,
            on_state=lambda state: states.append(copy.deepcopy(state)),
        )
        self.assertFalse(first_report["ok"])
        resume_from = next(
            state for state in states if state["finished"] is not True
        )

        second_applier = FakeApplier()
        resumed = stream_chat_reply(
            TARGET,
            ["and the second half"],
            apply=second_applier,
            clock=Clock(step=500),
            resume_state=resume_from,
        )
        self.assertTrue(resumed["ok"])
        self.assertIn("the first half", resumed["finalText"])
        self.assertIn("and the second half", resumed["finalText"])

    def test_requires_apply(self) -> None:
        with self.assertRaises(TypeError):
            stream_chat_reply(TARGET, ["x"], apply=None)  # type: ignore[arg-type]


class AsyncStreamChatReplyTest(unittest.TestCase):
    def test_async_driver_with_async_iterable(self) -> None:
        applier = FakeApplier()

        async def stream():
            for chunk in ["hello ", "streamed ", "world"]:
                yield chunk

        async def main():
            return await astream_chat_reply(
                TARGET,
                stream(),
                apply=applier,
                clock=lambda: 0,
                min_patch_chars=5,
                min_interval_ms=0,
            )

        report = asyncio.run(main())
        self.assertTrue(report["ok"])
        self.assertEqual(report["finalText"], "hello streamed world")

    def test_async_driver_accepts_sync_iterables_and_async_apply(self) -> None:
        calls = []

        async def async_apply(request):
            calls.append(dict(request))
            return {"ok": True, "status": 200, "json": {}, "error": None}

        async def main():
            return await astream_chat_reply(
                TARGET,
                ["plain ", "sync ", "chunks"],
                apply=async_apply,
                clock=lambda: 0,
            )

        report = asyncio.run(main())
        self.assertTrue(report["ok"])
        self.assertEqual(report["finalText"], "plain sync chunks")
        self.assertTrue(calls[-1]["final"])


class CancellationRegistryTest(unittest.TestCase):
    def test_in_memory_registry(self) -> None:
        registry = InMemoryStreamCancellationRegistry()
        self.assertFalse(registry.is_cancelled("s1"))
        registry.cancel("s1", "stop")
        self.assertTrue(registry.is_cancelled("s1"))
        self.assertEqual(registry.reason("s1"), "stop")
        registry.clear("s1")
        self.assertFalse(registry.is_cancelled("s1"))

    def test_file_registry_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            file_path = pathlib.Path(tmp) / "cancels.json"
            writer = FileStreamCancellationRegistry(file_path)
            reader = FileStreamCancellationRegistry(file_path)
            self.assertFalse(reader.is_cancelled("s1"))
            writer.cancel("s1", "card button")
            self.assertTrue(reader.is_cancelled("s1"))
            self.assertEqual(reader.reason("s1"), "card button")
            writer.clear("s1")
            self.assertFalse(reader.is_cancelled("s1"))

    def test_file_registry_matches_node_file_format(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            file_path = pathlib.Path(tmp) / "cancels.json"
            file_path.write_text(
                json.dumps(
                    {"version": 1, "cancelled": {"s9": "from node"}}, indent=2
                )
                + "\n"
            )
            registry = FileStreamCancellationRegistry(file_path)
            self.assertTrue(registry.is_cancelled("s9"))
            self.assertEqual(registry.reason("s9"), "from node")


if __name__ == "__main__":
    unittest.main()
