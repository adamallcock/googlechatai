import unittest

from googlechatai import (
    build_chat_link_cache_key,
    collect_chat_link_candidates,
    create_chat_link_retrieval_plan,
    normalize_message,
)


CHAT_MESSAGE_READ_SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly"
CHAT_SPACE_READ_SCOPE = "https://www.googleapis.com/auth/chat.spaces.readonly"
CHAT_APP_MESSAGE_READ_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly"


class ChatLinkRetrievalTests(unittest.TestCase):
    def test_prefers_structured_chat_space_link_data(self) -> None:
        raw = {
            "name": "spaces/AAA/messages/source",
            "text": "See launch thread",
            "createTime": "2026-07-05T15:00:00Z",
            "annotations": [
                {
                    "type": "RICH_LINK",
                    "startIndex": 4,
                    "length": 13,
                    "richLinkMetadata": {
                        "uri": "https://chat.google.com/u/0/app/chat/AAA/AAA/thread-1?cls=7",
                        "richLinkType": "CHAT_SPACE",
                        "title": "Launch thread",
                        "chatSpaceLinkData": {
                            "space": "spaces/AAA",
                            "thread": "spaces/AAA/threads/thread-1",
                            "message": "spaces/AAA/messages/msg-1",
                            "spaceDisplayName": "Launch Review",
                        },
                    },
                }
            ],
        }
        normalized = normalize_message(raw)

        self.assertEqual(
            normalized["links"][0]["chatSpaceLinkData"],
            {
                "space": "spaces/AAA",
                "thread": "spaces/AAA/threads/thread-1",
                "message": "spaces/AAA/messages/msg-1",
                "spaceDisplayName": "Launch Review",
            },
        )

        self.assertEqual(
            collect_chat_link_candidates(normalized),
            [
                {
                    "kind": "chat_link",
                    "candidateId": "chat-link-1",
                    "source": "chat_space_link_data",
                    "originalUrl": "https://chat.google.com/u/0/app/chat/AAA/AAA/thread-1?cls=7",
                    "title": "Launch thread",
                    "parseStatus": "parsed",
                    "confidence": "high",
                    "scope": "message",
                    "space": "spaces/AAA",
                    "thread": "spaces/AAA/threads/thread-1",
                    "message": "spaces/AAA/messages/msg-1",
                    "resourceName": "spaces/AAA/messages/msg-1",
                    "urlShape": "chat_space_link_data",
                    "context": {
                        "messageName": "spaces/AAA/messages/source",
                        "relationship": "self",
                        "path": ["self:spaces/AAA/messages/source"],
                        "sender": None,
                        "createdAt": "2026-07-05T15:00:00Z",
                        "updatedAt": None,
                        "deletedAt": None,
                        "accessState": None,
                    },
                    "warnings": [],
                }
            ],
        )

    def test_parses_known_shapes_without_overmatching(self) -> None:
        candidates = collect_chat_link_candidates(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://mail.google.com/mail/u/0/#chat/space/AAA",
                    },
                    {
                        "kind": "matchedUrl",
                        "url": "https://chat.google.com/room/AAA/thread-1?cls=11",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/u/2/app/chat/BBB",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/u/2/app/chat/BBB/BBB/thread-9",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://example.test/room/AAA",
                    },
                ]
            }
        )

        self.assertEqual(
            [
                {
                    "source": candidate["source"],
                    "parseStatus": candidate["parseStatus"],
                    "confidence": candidate["confidence"],
                    "scope": candidate["scope"],
                    "space": candidate["space"],
                    "thread": candidate["thread"],
                    "message": candidate["message"],
                    "resourceName": candidate["resourceName"],
                    "urlShape": candidate["urlShape"],
                    "warnings": candidate["warnings"],
                }
                for candidate in candidates
            ],
            [
                {
                    "source": "plain_url",
                    "parseStatus": "parsed",
                    "confidence": "high",
                    "scope": "space",
                    "space": "spaces/AAA",
                    "thread": None,
                    "message": None,
                    "resourceName": "spaces/AAA",
                    "urlShape": "gmail_hash_space",
                    "warnings": [],
                },
                {
                    "source": "matched_url",
                    "parseStatus": "parsed",
                    "confidence": "low",
                    "scope": "thread",
                    "space": "spaces/AAA",
                    "thread": "spaces/AAA/threads/thread-1",
                    "message": None,
                    "resourceName": "spaces/AAA/threads/thread-1",
                    "urlShape": "chat_room_thread",
                    "warnings": [
                        "Thread URL shape is empirical; verify with live corpus before treating as a stable Google contract."
                    ],
                },
                {
                    "source": "plain_url",
                    "parseStatus": "parsed",
                    "confidence": "medium",
                    "scope": "space",
                    "space": "spaces/BBB",
                    "thread": None,
                    "message": None,
                    "resourceName": "spaces/BBB",
                    "urlShape": "chat_app_space",
                    "warnings": [],
                },
                {
                    "source": "plain_url",
                    "parseStatus": "unknown",
                    "confidence": "unknown",
                    "scope": "unknown",
                    "space": None,
                    "thread": None,
                    "message": None,
                    "resourceName": None,
                    "urlShape": "unknown_chat_url",
                    "warnings": [
                        "Chat URL shape is not recognized; retained for corpus collection but no API request will be planned."
                    ],
                },
            ],
        )

    def test_parser_matrix(self) -> None:
        cases = [
            {
                "url": "https://mail.google.com/mail/u/0/#chat/space/AAA?ignored=1",
                "shape": "gmail_hash_space",
                "confidence": "high",
                "scope": "space",
                "resourceName": "spaces/AAA",
            },
            {
                "url": "https://mail.google.com/chat/u/0/#chat/space/GCHAT",
                "shape": "gmail_chat_hash_space",
                "confidence": "medium",
                "scope": "space",
                "resourceName": "spaces/GCHAT",
            },
            {
                "url": "https://chat.google.com/room/ROOM?cls=11#ignored",
                "shape": "chat_room_space",
                "confidence": "medium",
                "scope": "space",
                "resourceName": "spaces/ROOM",
            },
            {
                "url": "https://chat.google.com/room/THREAD/thread-1?cls=11",
                "shape": "chat_room_thread",
                "confidence": "low",
                "scope": "thread",
                "resourceName": "spaces/THREAD/threads/thread-1",
            },
            {
                "url": "https://chat.google.com/u/2/app/chat/BBB",
                "shape": "chat_app_space",
                "confidence": "medium",
                "scope": "space",
                "resourceName": "spaces/BBB",
            },
            {
                "url": "https://mail.google.com/mail/u/0/extra/#chat/space/AAA",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://mail.google.com/chat/u/0/extra/#chat/space/AAA",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://mail.google.com/mail/u/notnum/#chat/space/AAA",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://chat.google.com/u/notnum/app/chat/BBB",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://mail.google.com/mail/u/0/#chat/dm/AAA",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://mail.google.com/mail/u/0/#chat/space/AAA%2FBBB",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://mail.google.com/mail/u/0/#chat/space/AAA/thread-1",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://chat.google.com/room/AAA%2FBBB",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://chat.google.com/u/2/app/chat/BBB/BBB/thread-9",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "https://chat.google.com/room/AAA/thread%22x",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "http://chat.google.com/room/AAA",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
            {
                "url": "http://mail.google.com/mail/u/0/#chat/space/AAA",
                "shape": "unknown_chat_url",
                "confidence": "unknown",
                "scope": "unknown",
                "resourceName": None,
            },
        ]

        self.assertEqual(
            [
                {
                    "shape": candidate["urlShape"],
                    "confidence": candidate["confidence"],
                    "scope": candidate["scope"],
                    "resourceName": candidate["resourceName"],
                }
                for candidate in collect_chat_link_candidates(
                    {"links": [{"kind": "plain_url", "url": item["url"]} for item in cases]}
                )
            ],
            [
                {
                    "shape": item["shape"],
                    "confidence": item["confidence"],
                    "scope": item["scope"],
                    "resourceName": item["resourceName"],
                }
                for item in cases
            ],
        )

    def test_accepts_direct_list_of_links(self) -> None:
        self.assertEqual(
            collect_chat_link_candidates(
                [{"kind": "plain_url", "url": "https://chat.google.com/room/AAA"}]
            )[0]["resourceName"],
            "spaces/AAA",
        )

    def test_can_be_disabled_by_feature_flag_option(self) -> None:
        self.assertEqual(
            collect_chat_link_candidates(
                {
                    "text": "https://chat.google.com/room/AAA",
                    "options": {"enabled": False},
                }
            ),
            [],
        )

        plan = create_chat_link_retrieval_plan(
            {
                "links": [
                    {"kind": "plain_url", "url": "https://chat.google.com/room/AAA"}
                ],
                "options": {"enabled": False},
            }
        )

        self.assertEqual(plan["status"], "blocked")
        self.assertEqual(plan["summary"], "Chat link retrieval planning is disabled by option.")
        self.assertEqual(plan["counts"]["candidates"], 0)
        self.assertEqual(plan["counts"]["plannedRequests"], 0)
        self.assertEqual(plan["candidates"], [])
        self.assertEqual(plan["requests"], [])
        self.assertIn(
            "System Note: Chat link retrieval planning is disabled by option.",
            plan["systemNotes"],
        )

    def test_malformed_plain_text_urls_do_not_crash_candidate_collection(self) -> None:
        self.assertEqual(
            [
                candidate["resourceName"]
                for candidate in collect_chat_link_candidates(
                    {
                        "text": "bad https://[::1 then good https://chat.google.com/room/AAA"
                    }
                )
            ],
            ["spaces/AAA"],
        )

    def test_carries_source_message_sender_and_timestamp_breadcrumbs(self) -> None:
        candidate = collect_chat_link_candidates(
            {
                "name": "spaces/AAA/messages/source",
                "createTime": "2026-07-05T15:00:00Z",
                "lastUpdateTime": "2026-07-05T15:05:00Z",
                "sender": {
                    "name": "users/ada",
                    "displayName": "Ada Lovelace",
                    "email": "ada@example.com",
                    "type": "HUMAN",
                },
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/room/AAA",
                    }
                ],
            }
        )[0]

        self.assertEqual(
            candidate["context"],
            {
                "messageName": "spaces/AAA/messages/source",
                "relationship": "self",
                "path": ["self:spaces/AAA/messages/source"],
                "sender": {
                    "displayName": "Ada Lovelace",
                    "email": "ada@example.com",
                    "resourceName": "users/ada",
                    "type": "HUMAN",
                    "accessState": "available",
                    "ambiguityState": "unambiguous",
                },
                "createdAt": "2026-07-05T15:00:00Z",
                "updatedAt": "2026-07-05T15:05:00Z",
                "deletedAt": None,
                "accessState": None,
            },
        )

    def test_applies_source_toggles_to_annotation_derived_links(self) -> None:
        candidates = collect_chat_link_candidates(
            {
                "annotations": [
                    {
                        "kind": "matchedUrl",
                        "url": "https://chat.google.com/room/AAA",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/room/BBB",
                    },
                    {
                        "kind": "richLink",
                        "url": "https://chat.google.com/room/CCC",
                    },
                ]
            },
            include_matched_urls=False,
            include_plain_text_urls=False,
        )

        self.assertEqual(
            [candidate["resourceName"] for candidate in candidates],
            ["spaces/CCC"],
        )

    def test_applies_rich_link_source_toggles(self) -> None:
        candidates = collect_chat_link_candidates(
            {
                "links": [
                    {
                        "kind": "richLink",
                        "url": "https://chat.google.com/room/RICH",
                    },
                    {
                        "kind": "richLink",
                        "url": "https://chat.google.com/room/STRUCTURED",
                        "chatSpaceLinkData": {
                            "space": "spaces/STRUCTURED",
                        },
                    },
                    {
                        "kind": "matchedUrl",
                        "url": "https://chat.google.com/room/MATCHED",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/room/PLAIN",
                    },
                ]
            },
            include_rich_links=False,
        )

        self.assertEqual(
            [candidate["resourceName"] for candidate in candidates],
            ["spaces/MATCHED", "spaces/PLAIN"],
        )

    def test_rejects_cross_space_chat_space_link_data(self) -> None:
        candidate = collect_chat_link_candidates(
            {
                "links": [
                    {
                        "kind": "richLink",
                        "url": "https://chat.google.com/u/0/app/chat/AAA",
                        "chatSpaceLinkData": {
                            "message": "spaces/AAA/messages/msg-1",
                            "thread": "spaces/BBB/threads/thread-1",
                        },
                    }
                ]
            }
        )[0]

        self.assertEqual(candidate["parseStatus"], "invalid")
        self.assertEqual(candidate["confidence"], "unknown")
        self.assertEqual(candidate["scope"], "unknown")
        self.assertIsNone(candidate["resourceName"])
        self.assertEqual(candidate["urlShape"], "invalid_chat_space_link_data")
        self.assertEqual(
            candidate["warnings"],
            ["chatSpaceLinkData resource names point at different spaces."],
        )

    def test_creates_dry_run_plan_with_cache_metadata(self) -> None:
        plan = create_chat_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "richLink",
                        "url": "https://chat.google.com/u/0/app/chat/AAA",
                        "title": "Message",
                        "chatSpaceLinkData": {
                            "space": "spaces/AAA",
                            "message": "spaces/AAA/messages/msg-1",
                        },
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/room/AAA/thread-1",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/u/2/app/chat/BBB",
                    },
                ],
                "options": {
                    "authMode": "user",
                    "allowSpaceLevelContext": True,
                    "maxThreadMessages": 12,
                    "maxSpaceMessages": 5,
                    "cache": {
                        "entriesByResourceName": {
                            "spaces/AAA/messages/msg-1": {
                                "hit": True,
                                "key": "chat-link:cached-message",
                                "lastUpdateTime": "2026-07-05T15:10:00Z",
                            }
                        }
                    },
                },
            }
        )

        self.assertEqual(plan["kind"], "chat.chat_link_retrieval_plan")
        self.assertEqual(plan["status"], "ready")
        self.assertTrue(plan["dryRun"])
        self.assertEqual(plan["counts"]["plannedRequests"], 5)
        self.assertEqual(plan["counts"]["cacheHits"], 1)
        self.assertEqual(
            plan["capability"]["requiredScopes"],
            [CHAT_MESSAGE_READ_SCOPE, CHAT_SPACE_READ_SCOPE],
        )
        self.assertEqual(
            plan["requests"][0],
            {
                "candidateId": "chat-link-1",
                "candidateIds": ["chat-link-1"],
                "resource": "spaces.messages.get",
                "method": "GET",
                "path": "/v1/spaces/AAA/messages/msg-1",
                "query": {"fields": "name,lastUpdateTime,thread.name"},
                "body": None,
                "purpose": "read_message_or_revalidate_cache",
            },
        )
        self.assertEqual(
            plan["requests"][1],
            {
                "candidateId": "chat-link-1",
                "candidateIds": ["chat-link-1", "chat-link-2"],
                "resource": "spaces.get",
                "method": "GET",
                "path": "/v1/spaces/AAA",
                "query": {},
                "body": None,
                "purpose": "read_space_breadcrumb",
            },
        )
        self.assertEqual(
            plan["candidates"][0]["cache"],
            {
                "status": "hit",
                "strategy": "resource_last_update_time",
                "key": "chat-link:cached-message",
                "resourceName": "spaces/AAA/messages/msg-1",
                "lastUpdateTime": "2026-07-05T15:10:00Z",
                "revalidateWith": "spaces.messages.get",
            },
        )

    def test_deduplicates_text_urls_and_trims_terminal_punctuation(self) -> None:
        self.assertEqual(
            [
                {
                    "source": candidate["source"],
                    "originalUrl": candidate["originalUrl"],
                    "scope": candidate["scope"],
                    "resourceName": candidate["resourceName"],
                }
                for candidate in collect_chat_link_candidates(
                    {
                        "text": "Discuss https://chat.google.com/room/AAA.",
                        "matchedUrl": {
                            "url": "https://chat.google.com/room/AAA",
                        },
                    }
                )
            ],
            [
                {
                    "source": "matched_url",
                    "originalUrl": "https://chat.google.com/room/AAA",
                    "scope": "space",
                    "resourceName": "spaces/AAA",
                }
            ],
        )

        self.assertEqual(
            collect_chat_link_candidates(
                {"text": "Discuss https://chat.google.com/room/AAA."}
            )[0]["originalUrl"],
            "https://chat.google.com/room/AAA",
        )

    def test_deduplicates_repeated_resources_across_contexts(self) -> None:
        plan = create_chat_link_retrieval_plan(
            {
                "messages": [
                    {
                        "name": "spaces/AAA/messages/one",
                        "text": "https://chat.google.com/room/AAA",
                    },
                    {
                        "name": "spaces/AAA/messages/two",
                        "text": "https://chat.google.com/room/AAA",
                    },
                ],
                "options": {"allowSpaceLevelContext": True},
            }
        )

        self.assertEqual(plan["counts"]["candidates"], 1)
        self.assertEqual(plan["counts"]["plannedRequests"], 2)
        self.assertEqual(
            plan["candidates"][0]["occurrences"],
            [
                {
                    "messageName": "spaces/AAA/messages/one",
                    "relationship": "message-0",
                    "path": [
                        "input",
                        "message-0:spaces/AAA/messages/one",
                    ],
                },
                {
                    "messageName": "spaces/AAA/messages/two",
                    "relationship": "message-1",
                    "path": [
                        "input",
                        "message-1:spaces/AAA/messages/two",
                    ],
                },
            ],
        )

    def test_surfaces_traversal_caps(self) -> None:
        class TrackingList(list):
            def __init__(self, values: list[dict[str, str]]) -> None:
                super().__init__(values)
                self.reads = 0

            def __getitem__(self, index: int) -> dict[str, str]:
                self.reads += 1
                return super().__getitem__(index)

        messages = TrackingList(
            [
                {
                    "name": f"spaces/AAA/messages/{index}",
                    "text": f"https://chat.google.com/room/{index}",
                }
                for index in range(20)
            ]
        )
        plan = create_chat_link_retrieval_plan(
            {
                "messages": messages,
                "options": {
                    "maxTraversalNodes": 3,
                    "maxChatLinks": 1,
                },
            }
        )

        self.assertEqual(plan["status"], "partial")
        self.assertEqual(plan["truncation"]["status"], "truncated")
        self.assertEqual(messages.reads, 2)
        self.assertGreater(plan["counts"]["cappedCandidates"], 0)
        self.assertEqual(plan["counts"]["cappedTraversalNodes"], 18)
        self.assertIn(
            "System Note: Chat link traversal was capped; some linked Chat context may be omitted.",
            plan["systemNotes"],
        )

    def test_bounds_plain_text_scanning_and_occurrences(self) -> None:
        long_url = "https://chat.google.com/room/" + ("A" * 80)
        plan = create_chat_link_retrieval_plan(
            {
                "messages": [
                    {
                        "name": "spaces/AAA/messages/one",
                        "text": long_url
                        + " https://chat.google.com/room/OK trailing text beyond scan budget",
                    },
                    {
                        "name": "spaces/AAA/messages/two",
                        "text": "https://chat.google.com/room/OK",
                    },
                    {
                        "name": "spaces/AAA/messages/three",
                        "text": "https://chat.google.com/room/OK",
                    },
                ],
                "options": {
                    "allowSpaceLevelContext": False,
                    "maxPlainTextScanChars": 145,
                    "maxUrlLength": 50,
                    "maxOccurrencesPerCandidate": 2,
                },
            }
        )

        self.assertEqual(plan["status"], "partial")
        self.assertEqual(
            [candidate["resourceName"] for candidate in plan["candidates"]],
            ["spaces/OK"],
        )
        self.assertEqual(len(plan["candidates"][0]["occurrences"]), 2)
        self.assertGreater(plan["counts"]["cappedPlainTextScanChars"], 0)
        self.assertEqual(plan["counts"]["cappedOversizedUrls"], 1)
        self.assertEqual(plan["counts"]["cappedOccurrences"], 1)
        self.assertEqual(plan["truncation"]["status"], "truncated")

    def test_validates_auth_mode_and_app_auth_scopes(self) -> None:
        app_plan = create_chat_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/room/AAA/thread-1",
                    }
                ],
                "options": {"authMode": "app"},
            }
        )
        self.assertEqual(
            app_plan["capability"]["requiredScopes"],
            [CHAT_APP_MESSAGE_READ_SCOPE, "https://www.googleapis.com/auth/chat.bot"],
        )
        self.assertTrue(app_plan["capability"]["requiresAdminApproval"])

        invalid = create_chat_link_retrieval_plan(
            {
                "links": [
                    {"kind": "plain_url", "url": "https://chat.google.com/room/AAA"}
                ],
                "options": {"authMode": "usr"},
            }
        )
        self.assertEqual(invalid["status"], "blocked")
        self.assertEqual(invalid["requests"], [])
        self.assertFalse(invalid["capability"]["ok"])
        self.assertEqual(invalid["capability"]["reasons"], ["invalid_auth_mode"])

    def test_ignores_fractional_positive_integer_options(self) -> None:
        plan = create_chat_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/room/AAA/thread-1",
                    }
                ],
                "options": {"maxThreadMessages": 0.5},
            }
        )
        self.assertEqual(plan["requests"][0]["query"]["pageSize"], 50)

    def test_uses_lazy_cache_lookups(self) -> None:
        class TrackingEntries(dict):
            def __init__(self, values: dict[str, object]) -> None:
                super().__init__(values)
                self.iterations = 0
                self.items_reads = 0
                self.unrelated_reads = 0

            def __iter__(self):
                self.iterations += 1
                return super().__iter__()

            def items(self):
                self.items_reads += 1
                return super().items()

            def get(self, key, default=None):
                if key == "spaces/UNRELATED/messages/msg-1":
                    self.unrelated_reads += 1
                return super().get(key, default)

        entries = TrackingEntries(
            {
                "spaces/AAA/threads/thread-1": {
                    "hit": True,
                    "key": "chat-link:cached-thread",
                    "last_update_time": "2026-07-05T15:10:00Z",
                },
                "spaces/UNRELATED/messages/msg-1": {
                    "hit": True,
                    "key": "chat-link:unrelated",
                },
            }
        )
        plan = create_chat_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/room/AAA/thread-1",
                    }
                ],
                "options": {
                    "cache": {
                        "entries_by_resource_name": entries,
                    }
                },
            }
        )

        self.assertEqual(plan["candidates"][0]["cache"]["status"], "hit")
        self.assertEqual(plan["candidates"][0]["cache"]["key"], "chat-link:cached-thread")
        self.assertEqual(
            plan["candidates"][0]["cache"]["lastUpdateTime"],
            "2026-07-05T15:10:00Z",
        )
        self.assertEqual(entries.iterations, 0)
        self.assertEqual(entries.items_reads, 0)
        self.assertEqual(entries.unrelated_reads, 0)

    def test_accepts_python_native_snake_case_options_and_cache_aliases(self) -> None:
        plan = create_chat_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://chat.google.com/room/AAA/thread-1",
                    }
                ]
            },
            auth_mode="app",
            max_thread_messages=7,
            cache={
                "entries_by_resource_name": {
                    "spaces/AAA/threads/thread-1": {
                        "hit": True,
                        "key": "chat-link:cached-thread",
                        "last_update_time": "2026-07-05T15:10:00Z",
                    }
                }
            },
        )

        self.assertEqual(
            plan["capability"]["requiredScopes"],
            [CHAT_APP_MESSAGE_READ_SCOPE, "https://www.googleapis.com/auth/chat.bot"],
        )
        self.assertEqual(plan["requests"][0]["query"]["pageSize"], 7)
        self.assertEqual(
            plan["requests"][0]["query"]["fields"],
            "messages(name,lastUpdateTime,thread.name),nextPageToken",
        )
        self.assertEqual(plan["candidates"][0]["cache"]["key"], "chat-link:cached-thread")
        self.assertEqual(
            plan["candidates"][0]["cache"]["lastUpdateTime"],
            "2026-07-05T15:10:00Z",
        )

    def test_cache_keys_change_when_edit_metadata_changes(self) -> None:
        self.assertEqual(
            build_chat_link_cache_key(
                {
                    "resourceName": "spaces/AAA/messages/msg-1",
                    "lastUpdateTime": "2026-07-05T15:10:00Z",
                }
            ),
            {
                "namespace": "chat_link",
                "key": "chat-link:5056f741a5be63d26305878efe1ac45c",
                "resourceName": "spaces/AAA/messages/msg-1",
                "lastUpdateTime": "2026-07-05T15:10:00Z",
            },
        )
        self.assertNotEqual(
            build_chat_link_cache_key(
                {
                    "resourceName": "spaces/AAA/messages/msg-1",
                    "lastUpdateTime": "2026-07-05T15:11:00Z",
                }
            )["key"],
            "chat-link:5056f741a5be63d26305878efe1ac45c",
        )


if __name__ == "__main__":
    unittest.main()
