import json
import pathlib
import unittest

from googlechatai.messages import plan_replace_cards, plan_search_messages
from googlechatai import (
    build_buffered_stream_patches,
    build_conversation_context,
    build_conversation_context_with_identity,
    build_update_mask,
    generate_client_message_id,
    generate_request_id,
    hydrate_placeholder_response_handle,
    InMemoryAsyncResponseQueue,
    InMemoryIdentityCache,
    plan_buffered_placeholder_completion,
    plan_buffered_stream_message,
    plan_async_response,
    plan_complete_placeholder_response,
    plan_delete_app_message,
    plan_edit_message,
    plan_find_or_setup_dm,
    plan_placeholder_response,
    plan_reply_to_event,
    plan_read_space_context,
    plan_read_thread_context,
    plan_reply_in_thread,
    project_model_context,
    plan_send_to_space,
    plan_send_to_user,
    plan_start_thread,
    plan_stream_message,
    resolve_reply_target,
    select_placeholder_text,
    sync_directory_users_to_cache,
)


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


PLANNERS = {
    "messages.sendToSpace": plan_send_to_space,
    "messages.sendToUser": plan_send_to_user,
    "messages.findOrSetupDm": plan_find_or_setup_dm,
    "messages.replyInThread": plan_reply_in_thread,
    "messages.replyToEvent": plan_reply_to_event,
    "messages.startThread": plan_start_thread,
    "messages.edit": plan_edit_message,
    "messages.deleteAppMessage": plan_delete_app_message,
    "messages.stream": plan_stream_message,
    "messages.placeholder.create": plan_placeholder_response,
    "messages.placeholder.complete": plan_complete_placeholder_response,
    "messages.placeholder.bufferedComplete": plan_buffered_placeholder_completion,
    "messages.async.plan": plan_async_response,
}


class MessageCallPlanTests(unittest.TestCase):
    def test_matches_shared_call_plan_cases(self) -> None:
        for test_case in read_json("conformance/cases/messages.call-plans.json"):
            with self.subTest(test_case["id"]):
                self.assertEqual(
                    PLANNERS[test_case["operation"]](test_case["input"]),
                    test_case["expect"],
                )

    def test_generates_stable_ids_from_seeds(self) -> None:
        self.assertEqual(generate_request_id("W9 Stream #1"), "req-w9-stream-1")
        self.assertEqual(
            generate_client_message_id("W9 Stream #1"), "client-w9-stream-1"
        )

    def test_generates_update_masks_in_google_chat_patch_field_order(self) -> None:
        self.assertEqual(
            build_update_mask(
                {"accessoryWidgets": [], "text": "hi", "cardsV2": []}
            ),
            "text,cardsV2,accessoryWidgets",
        )

    def test_resolves_reply_targets_by_mimicking_chat_context(self) -> None:
        self.assertEqual(
            {
                key: resolve_reply_target(
                    {
                        "event": {
                            "kind": "message.direct",
                            "space": {"name": "spaces/DM1", "type": "DM"},
                            "message": {
                                "state": {
                                    "directMessage": True,
                                    "threadReply": False,
                                }
                            },
                        }
                    }
                )[key]
                for key in ("conversation", "route", "space", "threadName", "threadKey", "reason")
            },
            {
                "conversation": "dm",
                "route": "topLevel",
                "space": "spaces/DM1",
                "threadName": None,
                "threadKey": None,
                "reason": "dm_top_level",
            },
        )

        thread_target = resolve_reply_target(
            {
                "event": {
                    "kind": "message.thread_reply",
                    "space": {"name": "spaces/AAA", "type": "ROOM"},
                    "message": {
                        "thread": {"name": "spaces/AAA/threads/T1"},
                        "state": {"threadReply": True, "directMessage": False},
                    },
                }
            }
        )
        self.assertEqual(thread_target["route"], "thread")
        self.assertEqual(thread_target["threadName"], "spaces/AAA/threads/T1")
        self.assertEqual(
            thread_target["messageReplyOption"], "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
        )
        self.assertEqual(thread_target["reason"], "room_thread_reply")

        top_level_target = resolve_reply_target(
            {
                "event": {
                    "kind": "message.mentioned_app",
                    "space": {"name": "spaces/AAA", "type": "ROOM"},
                    "message": {
                        "ref": {"name": "spaces/AAA/messages/ROOT"},
                        "state": {"threadReply": False, "directMessage": False},
                    },
                }
            }
        )
        self.assertEqual(top_level_target["route"], "thread")
        self.assertEqual(
            top_level_target["threadKey"], "chat-ai-sdk-reply-spaces-aaa-messages-root"
        )
        self.assertEqual(top_level_target["reason"], "room_top_level_thread_key")

    def test_reply_routing_can_force_top_level(self) -> None:
        target = resolve_reply_target(
            {
                "event": {
                    "kind": "message.thread_reply",
                    "space": {"name": "spaces/AAA", "type": "ROOM"},
                    "message": {
                        "thread": {"name": "spaces/AAA/threads/T1"},
                        "state": {"threadReply": True, "directMessage": False},
                    },
                },
                "replyRouting": {"strategy": "topLevel"},
            }
        )

        self.assertEqual(target["route"], "topLevel")
        self.assertIsNone(target["threadName"])
        self.assertIsNone(target["threadKey"])
        self.assertIsNone(target["messageReplyOption"])
        self.assertEqual(target["reason"], "forced_top_level")

    def test_invalid_reply_routing_options_are_rejected(self) -> None:
        with self.assertRaisesRegex(TypeError, "replyRouting.messageReplyOption"):
            resolve_reply_target(
                {
                    "event": {
                        "kind": "message.mentioned_app",
                        "space": {"name": "spaces/AAA", "type": "ROOM"},
                        "message": {
                            "state": {
                                "threadReply": False,
                                "directMessage": False,
                            }
                        },
                    },
                    "replyRouting": {
                        "messageReplyOption": "REPLY_SOMEWHERE_MAYBE",
                    },
                }
            )

    def test_top_level_room_messages_with_thread_names_are_top_level_invocations(self) -> None:
        target = resolve_reply_target(
            {
                "event": {
                    "kind": "message.mentioned_app",
                    "space": {"name": "spaces/AAA", "type": "ROOM"},
                    "message": {
                        "thread": {"name": "spaces/AAA/threads/ROOT"},
                        "state": {"threadReply": False, "directMessage": False},
                    },
                },
                "replyRouting": {
                    "roomTopLevel": "topLevel",
                    "roomThreadReply": "thread",
                },
            }
        )

        self.assertEqual(target["conversation"], "space")
        self.assertEqual(target["route"], "topLevel")
        self.assertIsNone(target["threadName"])
        self.assertIsNone(target["threadKey"])
        self.assertEqual(target["reason"], "room_top_level_top_level")

    def test_plans_reply_to_event_sends_using_resolved_target(self) -> None:
        plan = plan_reply_to_event(
            {
                "event": {
                    "kind": "message.thread_reply",
                    "space": {"name": "spaces/AAA", "type": "ROOM"},
                    "message": {
                        "thread": {"name": "spaces/AAA/threads/T1"},
                        "state": {"threadReply": True, "directMessage": False},
                    },
                },
                "text": "Answer in the same thread.",
                "requestId": "req-reply-route",
                "clientMessageId": "client-reply-route",
            }
        )

        self.assertEqual(
            plan["requests"],
            [
                {
                    "resource": "spaces.messages.create",
                    "method": "POST",
                    "path": "/v1/spaces/AAA/messages",
                    "query": {
                        "requestId": "req-reply-route",
                        "messageId": "client-reply-route",
                        "messageReplyOption": "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
                    },
                    "body": {
                        "text": "Answer in the same thread.",
                        "thread": {"name": "spaces/AAA/threads/T1"},
                    },
                }
            ],
        )
        self.assertEqual(plan["replyTarget"]["route"], "thread")
        self.assertEqual(plan["replyTarget"]["threadName"], "spaces/AAA/threads/T1")

    def test_plans_placeholders_from_event_reply_routing_metadata(self) -> None:
        plan = plan_placeholder_response(
            {
                "event": {
                    "kind": "message.mentioned_app",
                    "space": {"name": "spaces/AAA", "type": "ROOM"},
                    "message": {
                        "ref": {"name": "spaces/AAA/messages/ROOT"},
                        "state": {"threadReply": False, "directMessage": False},
                    },
                },
                "placeholderText": "Thinking...",
                "requestId": "req-event-placeholder",
                "clientMessageId": "client-event-placeholder",
                "correlationId": "event-root",
            }
        )

        self.assertEqual(plan["requests"][0]["path"], "/v1/spaces/AAA/messages")
        self.assertEqual(
            plan["requests"][0]["query"],
            {
                "requestId": "req-event-placeholder",
                "messageId": "client-event-placeholder",
                "messageReplyOption": "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
            },
        )
        self.assertEqual(
            plan["requests"][0]["body"]["thread"],
            {"threadKey": "chat-ai-sdk-reply-spaces-aaa-messages-root"},
        )
        self.assertEqual(plan["placeholder"]["replyTarget"]["route"], "thread")
        self.assertEqual(
            plan["placeholder"]["replyTarget"]["threadKey"],
            "chat-ai-sdk-reply-spaces-aaa-messages-root",
        )
        self.assertEqual(
            plan["placeholder"]["handle"]["replyTarget"]["threadKey"],
            "chat-ai-sdk-reply-spaces-aaa-messages-root",
        )

    def test_buffers_model_chunks_into_bounded_edit_stream_patches(self) -> None:
        input_payload = read_json("fixtures/messages/buffered-stream.json")
        expected = read_json("fixtures/expected/messages/buffered-stream.json")

        self.assertEqual(
            build_buffered_stream_patches(input_payload),
            expected["streaming"]["buffering"],
        )
        self.assertEqual(plan_buffered_stream_message(input_payload), expected)
        self.assertEqual(
            build_buffered_stream_patches({**input_payload, "throttleMs": 0})["cadence"][
                "throttleMs"
            ],
            0,
        )

    def test_selects_placeholder_text_from_configurable_defaults_and_modes(self) -> None:
        self.assertEqual(
            select_placeholder_text({}),
            {
                "kind": "chat.placeholder_text_selection",
                "text": "Thinking...",
                "mode": "first",
                "index": 0,
                "count": 3,
                "source": "default",
                "nextCursor": None,
                "randomSeed": None,
                "warnings": [],
            },
        )
        self.assertEqual(
            select_placeholder_text(
                {
                    "placeholderTexts": ["One", "Two", "Three"],
                    "placeholderMode": "roundRobin",
                    "placeholderCursor": 4,
                }
            ),
            {
                "kind": "chat.placeholder_text_selection",
                "text": "Two",
                "mode": "roundRobin",
                "index": 1,
                "count": 3,
                "source": "placeholderTexts",
                "nextCursor": 5,
                "randomSeed": None,
                "warnings": [],
            },
        )
        self.assertEqual(
            select_placeholder_text(
                {
                    "placeholderTexts": ["One", "Two", "Three"],
                    "placeholderMode": "random",
                    "placeholderRandomSeed": "abc",
                }
            ),
            {
                "kind": "chat.placeholder_text_selection",
                "text": "Three",
                "mode": "random",
                "index": 2,
                "count": 3,
                "source": "placeholderTexts",
                "nextCursor": None,
                "randomSeed": "abc",
                "warnings": [],
            },
        )

    def test_parses_admin_placeholder_configs_from_json_and_csv_strings(self) -> None:
        self.assertEqual(
            select_placeholder_text(
                {
                    "placeholderConfigJson": json.dumps(
                        {
                            "texts": [
                                "Thinking...",
                                "Checking the thread...",
                                "Reviewing attachments...",
                            ],
                            "mode": "roundRobin",
                            "cursor": 2,
                        }
                    )
                }
            )["text"],
            "Reviewing attachments...",
        )
        csv_selection = select_placeholder_text(
            {
                "placeholderConfigCsv": "Thinking...,Checking context...,Reviewing files...",
                "placeholderMode": "roundRobin",
                "placeholderCursor": 1,
            }
        )
        self.assertEqual(csv_selection["text"], "Checking context...")
        self.assertEqual(csv_selection["source"], "placeholderConfigCsv")
        self.assertEqual(csv_selection["nextCursor"], 2)

    def test_refuses_empty_placeholder_pools_and_unknown_modes(self) -> None:
        with self.assertRaisesRegex(TypeError, "at least one non-empty placeholder"):
            select_placeholder_text({"placeholderTexts": ["", "   "]})
        with self.assertRaisesRegex(TypeError, "placeholderMode"):
            select_placeholder_text(
                {
                    "placeholderTexts": ["Thinking..."],
                    "placeholderMode": "shuffle",
                }
            )

    def test_hydrates_placeholder_response_handle_from_created_message(self) -> None:
        plan = plan_placeholder_response(
            {
                "space": "spaces/AAA",
                "thread": "spaces/AAA/threads/T1",
                "placeholderConfigJson": json.dumps(
                    {
                        "texts": [
                            "Thinking...",
                            "Checking recent context...",
                            "Reviewing files...",
                        ],
                        "mode": "roundRobin",
                        "cursor": 1,
                    }
                ),
                "authMode": "user",
                "requestId": "req-placeholder",
                "clientMessageId": "client-placeholder",
                "correlationId": "event-123",
            }
        )
        seed = plan["placeholder"]["handle"]

        self.assertEqual(
            hydrate_placeholder_response_handle(
                seed,
                {
                    "name": "spaces/AAA/messages/created-placeholder",
                    "createTime": "2026-07-04T00:00:00Z",
                    "thread": {"name": "spaces/AAA/threads/T1"},
                },
            ),
            {
                "kind": "chat.placeholder_response_handle",
                "space": "spaces/AAA",
                "messageName": "spaces/AAA/messages/created-placeholder",
                "threadName": "spaces/AAA/threads/T1",
                "threadKey": None,
                "requestId": "req-placeholder",
                "clientMessageId": "client-placeholder",
                "correlationId": "event-123",
                "authMode": "user",
                "createdAt": "2026-07-04T00:00:00Z",
                "editable": True,
                "allowedUpdateMasks": ["text", "cardsV2", "accessoryWidgets"],
            },
        )
        self.assertEqual(
            plan["placeholder"]["textSelection"]["text"],
            "Checking recent context...",
        )
        self.assertEqual(plan["placeholder"]["textSelection"]["nextCursor"], 2)

    def test_plans_placeholder_completion_as_patch_only_with_explicit_fallback(
        self,
    ) -> None:
        handle = {
            "kind": "chat.placeholder_response_handle",
            "space": "spaces/AAA",
            "messageName": "spaces/AAA/messages/placeholder",
            "threadName": "spaces/AAA/threads/T1",
            "threadKey": None,
            "requestId": "req-placeholder",
            "clientMessageId": "client-placeholder",
            "correlationId": "event-123",
            "authMode": "app",
            "createdAt": "2026-07-04T00:00:00Z",
            "editable": True,
            "allowedUpdateMasks": ["text", "cardsV2", "accessoryWidgets"],
        }

        plan = plan_complete_placeholder_response(
            {
                "handle": handle,
                "text": "Final answer",
                "onPatchFailure": "createNewMessage",
                "fallbackRequestId": "req-fallback",
                "fallbackClientMessageId": "client-fallback",
            }
        )

        self.assertEqual(
            plan["requests"],
            [
                {
                    "resource": "spaces.messages.patch",
                    "method": "PATCH",
                    "path": "/v1/spaces/AAA/messages/placeholder",
                    "query": {"updateMask": "text"},
                    "body": {"text": "Final answer"},
                }
            ],
        )
        self.assertEqual(plan["placeholder"]["strategy"], "edit-placeholder")
        self.assertEqual(plan["placeholder"]["state"], "complete")
        self.assertEqual(plan["placeholder"]["updateMask"], "text")
        self.assertEqual(
            plan["placeholder"]["fallback"],
            {
                "onPatchFailure": "createNewMessage",
                "request": {
                    "resource": "spaces.messages.create",
                    "method": "POST",
                    "path": "/v1/spaces/AAA/messages",
                    "query": {
                        "requestId": "req-fallback",
                        "messageId": "client-fallback",
                        "messageReplyOption": "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
                    },
                    "body": {
                        "text": "Final answer",
                        "thread": {"name": "spaces/AAA/threads/T1"},
                    },
                },
            },
        )

    def test_refuses_to_complete_uneditable_placeholder_handles(self) -> None:
        with self.assertRaisesRegex(TypeError, "editable placeholder response handle"):
            plan_complete_placeholder_response(
                {
                    "handle": {
                        "kind": "chat.placeholder_response_handle",
                        "space": "spaces/AAA",
                        "messageName": None,
                        "editable": False,
                    },
                    "text": "Final answer",
                }
            )

    def test_refuses_ambiguous_placeholder_thread_targets(self) -> None:
        with self.assertRaisesRegex(TypeError, "only one of thread or threadKey"):
            plan_placeholder_response(
                {
                    "space": "spaces/AAA",
                    "thread": "spaces/AAA/threads/T1",
                    "threadKey": "same-turn",
                }
            )

    def test_refuses_placeholder_completion_outside_update_mask(self) -> None:
        with self.assertRaisesRegex(TypeError, "does not allow updating cardsV2"):
            plan_complete_placeholder_response(
                {
                    "handle": {
                        "kind": "chat.placeholder_response_handle",
                        "space": "spaces/AAA",
                        "messageName": "spaces/AAA/messages/placeholder",
                        "threadName": None,
                        "threadKey": None,
                        "requestId": "req-placeholder",
                        "clientMessageId": "client-placeholder",
                        "correlationId": "event-123",
                        "authMode": "app",
                        "createdAt": "2026-07-04T00:00:00Z",
                        "editable": True,
                        "allowedUpdateMasks": ["text"],
                    },
                    "cardsV2": [{"cardId": "blocked"}],
                }
            )

    def test_buffers_placeholder_completion_without_creating_second_message(self) -> None:
        plan = plan_buffered_placeholder_completion(
            {
                "handle": {
                    "kind": "chat.placeholder_response_handle",
                    "space": "spaces/AAA",
                    "messageName": "spaces/AAA/messages/placeholder",
                    "threadName": "spaces/AAA/threads/T1",
                    "threadKey": None,
                    "requestId": "req-placeholder",
                    "clientMessageId": "client-placeholder",
                    "correlationId": "event-123",
                    "authMode": "app",
                    "createdAt": "2026-07-04T00:00:00Z",
                    "editable": True,
                    "allowedUpdateMasks": ["text", "cardsV2", "accessoryWidgets"],
                },
                "chunks": ["One. ", "Two. ", "Three."],
                "maxPatches": 2,
                "minPatchChars": 1,
                "throttleMs": 250,
            }
        )

        self.assertEqual(plan["operation"], "messages.placeholder.bufferedComplete")
        self.assertEqual(len(plan["requests"]), 2)
        self.assertTrue(
            all(request["method"] == "PATCH" for request in plan["requests"])
        )
        self.assertTrue(
            all(
                request["resource"] == "spaces.messages.patch"
                for request in plan["requests"]
            )
        )
        self.assertEqual(plan["streaming"]["strategy"], "edit-placeholder-buffered")

    def test_plans_async_placeholder_handoff_and_local_queue(self) -> None:
        plan = plan_async_response(
            {
                "space": "spaces/AAA",
                "thread": "spaces/AAA/threads/T1",
                "eventId": "event-123",
                "correlationId": "event-123",
                "authMode": "app",
                "expectedWorkMs": 45_000,
                "receivedAt": "2026-07-04T00:00:00.000Z",
                "now": "2026-07-04T00:00:03.000Z",
                "respondWithPlaceholder": True,
                "placeholderText": "Thinking...",
                "requestId": "req-async-placeholder",
                "clientMessageId": "client-async-placeholder",
                "createdMessage": {
                    "name": "spaces/AAA/messages/placeholder",
                    "createTime": "2026-07-04T00:00:03.500Z",
                    "thread": {"name": "spaces/AAA/threads/T1"},
                },
                "queue": {
                    "adapter": "cloudTasks",
                    "target": "projects/p/locations/us-central1/queues/chat-ai",
                },
                "payloadRef": "gs://chat-ai-sdk/tasks/event-123.json",
            }
        )

        self.assertEqual(plan["kind"], "chat.async_response_plan")
        self.assertEqual(plan["status"], "defer")
        self.assertEqual(plan["strategy"], "placeholder_then_queue")
        self.assertEqual(
            plan["deadline"],
            {
                "syncDeadlineMs": 30000,
                "safetyMarginMs": 5000,
                "elapsedMs": 3000,
                "remainingMs": 27000,
                "workBudgetMs": 22000,
                "expectedWorkMs": 45000,
                "shouldDefer": True,
                "reason": "expected_work_exceeds_sync_budget",
            },
        )
        self.assertEqual(plan["idempotency"]["idempotencyKey"], "chat-event:event-123")
        self.assertTrue(plan["replyHandle"]["editable"])
        self.assertEqual(
            plan["replyHandle"]["messageName"],
            "spaces/AAA/messages/placeholder",
        )
        self.assertEqual(len(plan["placeholderPlan"]["requests"]), 1)
        self.assertEqual(plan["queue"]["adapter"], "cloudTasks")
        self.assertEqual(plan["queue"]["task"]["taskId"], "task-event-123")
        self.assertEqual(plan["queue"]["task"]["replyHandle"], plan["replyHandle"])
        self.assertEqual(
            plan["queue"]["task"]["finalDelivery"],
            {
                "strategy": "edit_placeholder",
                "successOperation": "messages.placeholder.complete",
                "errorOperation": "messages.placeholder.complete",
                "onPatchFailure": "createNewMessage",
            },
        )

        queue = InMemoryAsyncResponseQueue()
        self.assertEqual(
            queue.enqueue(plan["queue"]["task"]),
            {
                "kind": "chat.async_queue_enqueue_result",
                "status": "enqueued",
                "depth": 1,
                "taskId": "task-event-123",
            },
        )
        self.assertEqual(queue.dequeue(), plan["queue"]["task"])
        self.assertIsNone(queue.dequeue())

    def test_async_placeholder_handoff_carries_event_reply_routing_metadata(self) -> None:
        plan = plan_async_response(
            {
                "event": {
                    "kind": "message.mentioned_app",
                    "space": {"name": "spaces/AAA", "type": "ROOM"},
                    "message": {
                        "ref": {"name": "spaces/AAA/messages/ROOT"},
                        "state": {"threadReply": False, "directMessage": False},
                    },
                },
                "eventId": "event-root",
                "correlationId": "event-root",
                "expectedWorkMs": 45_000,
                "receivedAt": "2026-07-04T00:00:00.000Z",
                "now": "2026-07-04T00:00:03.000Z",
                "respondWithPlaceholder": True,
                "placeholderText": "Thinking...",
                "requestId": "req-async-route",
                "clientMessageId": "client-async-route",
                "createdMessage": {
                    "name": "spaces/AAA/messages/placeholder",
                    "createTime": "2026-07-04T00:00:03.500Z",
                    "thread": {"name": "spaces/AAA/threads/generated"},
                },
                "queue": {
                    "adapter": "cloudTasks",
                    "target": "projects/p/locations/us-central1/queues/chat-ai",
                },
                "payloadRef": "gs://chat-ai-sdk/tasks/event-root.json",
            }
        )

        self.assertEqual(plan["replyTarget"]["route"], "thread")
        self.assertEqual(
            plan["replyTarget"]["threadKey"],
            "chat-ai-sdk-reply-spaces-aaa-messages-root",
        )
        self.assertEqual(
            plan["placeholderPlan"]["requests"][0]["body"]["thread"],
            {"threadKey": "chat-ai-sdk-reply-spaces-aaa-messages-root"},
        )
        self.assertEqual(
            plan["replyHandle"]["threadName"],
            "spaces/AAA/threads/generated",
        )
        self.assertEqual(
            plan["replyHandle"]["replyTarget"]["threadKey"],
            "chat-ai-sdk-reply-spaces-aaa-messages-root",
        )
        self.assertEqual(plan["queue"]["task"]["space"], "spaces/AAA")
        self.assertEqual(
            plan["queue"]["task"]["replyTarget"]["threadKey"],
            "chat-ai-sdk-reply-spaces-aaa-messages-root",
        )
        self.assertIn(
            "System Note: Reply routing selected a thread reply target.",
            plan["systemNotes"],
        )

    def test_async_response_chooses_sync_or_queue_only_without_placeholder(self) -> None:
        self.assertEqual(
            plan_async_response(
                {
                    "space": "spaces/AAA",
                    "eventId": "event-fast",
                    "expectedWorkMs": 1000,
                    "respondWithPlaceholder": False,
                    "receivedAt": "2026-07-04T00:00:00.000Z",
                    "now": "2026-07-04T00:00:01.000Z",
                }
            )["strategy"],
            "sync_response",
        )

        slow = plan_async_response(
            {
                "space": "spaces/AAA",
                "eventId": "event-slow",
                "expectedWorkMs": 45_000,
                "respondWithPlaceholder": False,
                "receivedAt": "2026-07-04T00:00:00.000Z",
                "now": "2026-07-04T00:00:03.000Z",
                "payloadRef": "gs://chat-ai-sdk/tasks/event-slow.json",
            }
        )

        self.assertEqual(slow["status"], "defer")
        self.assertEqual(slow["strategy"], "queue_only")
        self.assertIsNone(slow["placeholderPlan"])
        self.assertIsNone(slow["replyHandle"])
        self.assertEqual(slow["queue"]["adapter"], "localMemory")
        self.assertEqual(slow["queue"]["task"]["taskId"], "task-event-slow")
        self.assertEqual(
            slow["queue"]["task"]["finalDelivery"]["strategy"],
            "create_message",
        )

    def test_queue_only_async_work_uses_reply_to_event_final_delivery(self) -> None:
        plan = plan_async_response(
            {
                "event": {
                    "kind": "message.thread_reply",
                    "space": {"name": "spaces/AAA", "type": "ROOM"},
                    "message": {
                        "thread": {"name": "spaces/AAA/threads/T1"},
                        "state": {"threadReply": True, "directMessage": False},
                    },
                },
                "eventId": "event-thread",
                "expectedWorkMs": 45_000,
                "respondWithPlaceholder": False,
                "receivedAt": "2026-07-04T00:00:00.000Z",
                "now": "2026-07-04T00:00:03.000Z",
                "payloadRef": "gs://chat-ai-sdk/tasks/event-thread.json",
            }
        )

        self.assertEqual(plan["status"], "defer")
        self.assertEqual(plan["strategy"], "queue_only")
        self.assertEqual(plan["replyTarget"]["threadName"], "spaces/AAA/threads/T1")
        self.assertEqual(
            plan["queue"]["task"]["finalDelivery"],
            {
                "strategy": "create_reply_to_event",
                "successOperation": "messages.replyToEvent",
                "errorOperation": "messages.replyToEvent",
                "onPatchFailure": "createNewMessage",
            },
        )
        self.assertEqual(
            plan["completion"]["finalDeliveryStrategy"],
            "create_reply_to_event",
        )


class ContextReaderTests(unittest.TestCase):
    def test_matches_shared_context_cases(self) -> None:
        for test_case in read_json("conformance/cases/messages.context.json"):
            with self.subTest(test_case["id"]):
                responses = [
                    read_json(response["fixture"])
                    for response in test_case["apiResponses"]
                ]
                if test_case["operation"] == "threads.readContext":
                    plan = plan_read_thread_context(test_case["input"])
                else:
                    plan = plan_read_space_context(test_case["input"])

                self.assertEqual(plan, test_case["expect"]["plan"])
                self.assertEqual(
                    build_conversation_context(test_case["input"], responses),
                    test_case["expect"]["context"],
                )

    def test_model_projection_bounds_deeply_nested_quotes_iteratively(self) -> None:
        message: dict[str, object] = {
            "plainTextForModel": "leaf",
            "attachments": [],
            "quotedMessages": [],
        }
        for index in range(1_100):
            message = {
                "plainTextForModel": f"quote-{index}",
                "attachments": [],
                "quotedMessages": [message],
            }

        projected = project_model_context(
            {"kind": "chat.context", "messages": [message]},
            max_quote_depth=8,
        )

        self.assertTrue(projected["projection"]["quoteDepthLimited"])
        self.assertEqual(len(projected["fragments"]), 10)  # policy plus root and eight quotes

    def test_trims_model_context_by_estimated_token_budget(self) -> None:
        input_payload = {
            "space": "spaces/AAA",
            "authMode": "user",
            "limit": 5,
            "pageSize": 5,
            "order": "desc",
            "maxContextTokens": 45,
            "reserveOutputTokens": 5,
            "charsPerToken": 10,
        }
        responses = [
            read_json("fixtures/api-responses/messages/context-budget-page.json")
        ]
        plan = plan_read_space_context(input_payload)
        context = build_conversation_context(input_payload, responses)
        budget = context["modelTokenBudget"]

        self.assertEqual(
            plan["reader"]["modelTokenBudget"],
            {
                "maxTokens": 45,
                "reserveOutputTokens": 5,
                "availableTokens": 40,
                "strategy": "preserve_order",
                "estimator": {
                    "strategy": "chars_per_token",
                    "charsPerToken": 10,
                },
            },
        )
        self.assertEqual(budget["maxTokens"], 45)
        self.assertEqual(budget["reserveOutputTokens"], 5)
        self.assertEqual(budget["availableTokens"], 40)
        self.assertEqual(budget["includedMessages"], context["returnedMessages"])
        self.assertTrue(budget["truncated"])
        self.assertLessEqual(budget["estimatedTokensAfter"], 40)
        self.assertGreater(
            budget["estimatedTokensBefore"],
            budget["estimatedTokensAfter"],
        )
        self.assertGreater(budget["droppedMessages"], 0)
        self.assertTrue(context["partial"])
        self.assertTrue(context["truncated"])
        self.assertIn(
            "System Note: 3 message(s) were omitted to fit the model context budget of 40 estimated tokens.",
            context["systemNotes"],
        )
        self.assertEqual(
            [message["ref"]["name"] for message in context["messages"]],
            ["spaces/AAA/messages/budget-5", "spaces/AAA/messages/budget-4"],
        )

    def test_renders_custom_emoji_annotations_as_ai_facing_context_notes(self) -> None:
        context = build_conversation_context(
            {
                "space": "spaces/AAA",
                "authMode": "user",
                "limit": 1,
                "pageSize": 1,
                "order": "asc",
            },
            [
                {
                    "messages": [
                        {
                            "name": "spaces/AAA/messages/custom-emoji",
                            "text": "ship it :party_blob:",
                            "createTime": "2026-07-03T15:00:00Z",
                            "sender": {
                                "name": "users/ada",
                                "displayName": "Ada Lovelace",
                                "email": "ada@example.com",
                                "type": "HUMAN",
                            },
                            "annotations": [
                                {
                                    "type": "CUSTOM_EMOJI",
                                    "startIndex": 8,
                                    "length": 12,
                                    "customEmojiMetadata": {
                                        "customEmoji": {
                                            "name": "customEmojis/party_blob",
                                            "emojiName": ":party_blob:",
                                        },
                                    },
                                },
                            ],
                        }
                    ]
                }
            ],
        )

        self.assertIn(
            "System Note: Custom emoji :party_blob: (customEmojis/party_blob) appears in this message.",
            context["messages"][0]["systemNotes"],
        )

    def test_enriches_context_sender_identities_from_directory_cache_recursively(
        self,
    ) -> None:
        cache = InMemoryIdentityCache()
        sync_directory_users_to_cache(
            [
                {
                    "id": "ada",
                    "primaryEmail": "ada@example.com",
                    "name": {"fullName": "Ada Lovelace"},
                },
                {
                    "id": "grace",
                    "primaryEmail": "grace@example.com",
                    "name": {"fullName": "Grace Hopper"},
                },
            ],
            cache=cache,
            now_ms=1_782_930_000_000,
        )
        sync_directory_users_to_cache(
            [
                {
                    "id": "ada",
                    "primaryEmail": "ada@example.com",
                    "name": {"fullName": "Ada Lovelace"},
                }
            ],
            cache=cache,
            now_ms=1_782_933_600_000,
            mark_missing_stale=True,
        )

        context = build_conversation_context_with_identity(
            {
                "space": "spaces/AAA",
                "authMode": "user",
                "limit": 1,
                "pageSize": 1,
                "order": "asc",
                "maxQuoteDepth": 2,
            },
            [
                {
                    "messages": [
                        {
                            "name": "spaces/AAA/messages/root",
                            "text": "See quoted message",
                            "createTime": "2026-07-03T15:00:00Z",
                            "sender": {
                                "name": "users/ada",
                                "displayName": "users/ada",
                                "type": "HUMAN",
                            },
                            "quotedMessages": [
                                {
                                    "name": "spaces/AAA/messages/quote",
                                    "text": "Older context",
                                    "createTime": "2026-07-02T12:00:00Z",
                                    "sender": {
                                        "name": "users/grace",
                                        "displayName": "users/grace",
                                        "type": "HUMAN",
                                    },
                                }
                            ],
                        }
                    ]
                }
            ],
            identity_cache=cache,
        )

        message = context["messages"][0]
        quoted = message["quotedMessages"][0]

        self.assertEqual(
            message["sender"],
            {
                "name": "users/ada",
                "displayName": "Ada Lovelace",
                "email": "ada@example.com",
                "type": "HUMAN",
                "access": "available",
                "directoryStatus": "active",
                "source": "directory_cache",
                "stale": False,
                "lastDirectorySyncAt": "2026-07-01T19:20:00.000Z",
            },
        )
        self.assertIn(
            "System Note: The sender is Ada Lovelace <ada@example.com>.",
            message["systemNotes"],
        )
        self.assertEqual(
            quoted["sender"],
            {
                "name": "users/grace",
                "displayName": "Grace Hopper",
                "email": "grace@example.com",
                "type": "HUMAN",
                "access": "available",
                "directoryStatus": "stale",
                "source": "directory_cache",
                "stale": True,
                "lastDirectorySyncAt": "2026-07-01T18:20:00.000Z",
            },
        )
        self.assertIn(
            "System Note: The sender is Grace Hopper <grace@example.com>. This directory record is stale and may be out of date.",
            quoted["systemNotes"],
        )

    def test_keeps_context_handling_available_when_identity_enrichment_fails(
        self,
    ) -> None:
        class FailingCache:
            def get_by_id(self, user_id: str):
                raise RuntimeError("cache unavailable")

            def get_by_email(self, email: str):
                raise RuntimeError("cache unavailable")

        context = build_conversation_context_with_identity(
            {
                "space": "spaces/AAA",
                "authMode": "user",
                "limit": 1,
                "pageSize": 1,
            },
            [
                {
                    "messages": [
                        {
                            "name": "spaces/AAA/messages/root",
                            "text": "hello",
                            "createTime": "2026-07-03T15:00:00Z",
                            "sender": {
                                "name": "users/ada",
                                "displayName": "users/ada",
                                "type": "HUMAN",
                            },
                        }
                    ]
                }
            ],
            identity_cache=FailingCache(),
        )

        self.assertEqual(
            context["messages"][0]["sender"],
            {
                "name": "users/ada",
                "displayName": "users/ada",
                "email": None,
                "type": "HUMAN",
                "access": "available",
            },
        )
        self.assertIn(
            "System Note: Identity enrichment was skipped because the identity cache was unavailable.",
            context["systemNotes"],
        )


if __name__ == "__main__":
    unittest.main()


class DocsListedPlannersTest(unittest.TestCase):
    def test_search_clamps_page_size_and_warns(self) -> None:
        plan = plan_search_messages(
            {"space": "spaces/AAA", "query": "hello", "pageSize": 5000}
        )
        self.assertEqual(plan["requests"][0]["query"]["pageSize"], 1000)
        self.assertEqual(
            plan["requests"][0]["path"], "/v1/spaces/AAA/messages:search"
        )
        self.assertIn("docs-listed", plan["warnings"][0])

    def test_search_requires_query(self) -> None:
        with self.assertRaises(TypeError):
            plan_search_messages({"space": "spaces/AAA"})

    def test_replace_cards_plans_and_validates(self) -> None:
        plan = plan_replace_cards(
            {
                "message": "spaces/AAA/messages/BBB",
                "cardsV2": [{"cardId": "x", "card": {}}],
            }
        )
        self.assertEqual(
            plan["requests"][0]["path"], "/v1/spaces/AAA/messages/BBB:replaceCards"
        )
        with self.assertRaises(TypeError):
            plan_replace_cards({"message": "spaces/AAA/messages/BBB", "cardsV2": []})
