import json
import os
import pathlib
import unittest
from unittest import mock

from googlechatai.attachments import (
    collect_attachments_from_context,
    collect_drive_link_candidates,
    create_drive_export_plan,
    create_drive_link_retrieval_plan,
    create_download_plan,
    create_gemini_transcription_provider,
    create_openai_transcription_provider,
    create_upload_plan,
    normalize_attachment,
    plan_attachment_pipeline,
    parse_attachment_content,
    render_attachment_context_parts,
    summarize_transcription_evidence,
    transcribe_audio,
)
from googlechatai import normalize_message


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


class AttachmentTests(unittest.TestCase):
    def test_attachment_helpers_are_exported_from_package_root(self) -> None:
        from googlechatai import (
            collect_drive_link_candidates as root_collect_drive_link_candidates,
        )
        from googlechatai import (
            create_drive_link_retrieval_plan as root_create_drive_link_retrieval_plan,
        )
        from googlechatai import create_download_plan as root_create_download_plan
        from googlechatai import normalize_attachment as root_normalize_attachment

        attachment = root_normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/report",
                "contentName": "../launch report.pdf",
                "contentType": "application/pdf",
                "attachmentDataRef": {
                    "resourceName": "spaces/AAA/messages/root/attachments/report/media"
                },
            }
        )

        self.assertEqual(attachment["safeFilename"], "launch_report.pdf")
        self.assertEqual(root_create_download_plan(attachment)["status"], "dry_run")
        self.assertEqual(
            root_collect_drive_link_candidates,
            collect_drive_link_candidates,
        )
        self.assertEqual(
            root_create_drive_link_retrieval_plan,
            create_drive_link_retrieval_plan,
        )

    def test_normalizes_shared_attachment_fixtures_with_safe_filenames(self) -> None:
        raw = read_json("fixtures/attachments/context-tree.json")
        expected = read_json("fixtures/expected/attachments/normalized.context-tree.json")

        self.assertEqual(collect_attachments_from_context(raw), expected)

    def test_preserves_known_zero_byte_attachment_sizes(self) -> None:
        self.assertEqual(
            normalize_attachment(
                {
                    "name": "spaces/AAA/messages/root/attachments/empty-1",
                    "contentName": "empty.txt",
                    "contentType": "text/plain",
                    "contentSize": 0,
                }
            )["contentSizeBytes"],
            0,
        )

    def test_creates_download_and_upload_dry_run_plans(self) -> None:
        attachments = collect_attachments_from_context(
            read_json("fixtures/attachments/context-tree.json")
        )
        pdf = attachments[0]
        blocked = attachments[1]
        drive_image = attachments[3]

        self.assertEqual(
            create_download_plan(pdf, target_directory="/tmp/chat-ai-sdk"),
            {
                "kind": "download",
                "status": "dry_run",
                "dryRun": True,
                "canExecuteLive": False,
                "liveGate": {
                    "allowed": False,
                    "reasons": ["w7_not_complete", "env_flag_missing"],
                },
                "attachmentName": "spaces/AAA/messages/root/attachments/pdf-1",
                "mediaResourceName": "spaces/AAA/messages/root/attachments/pdf-1/media",
                "method": "GET",
                "url": "https://chat.googleapis.com/v1/media/spaces/AAA/messages/root/attachments/pdf-1/media?alt=media",
                "destinationPath": "/tmp/chat-ai-sdk/Q2_Final_.pdf",
                "policy": {
                    "status": "allowed",
                    "reasons": [],
                },
                "auth": {
                    "required": True,
                    "modes": ["app", "user"],
                    "scopes": [
                        "https://www.googleapis.com/auth/chat.bot",
                        "https://www.googleapis.com/auth/chat.messages",
                        "https://www.googleapis.com/auth/chat.messages.readonly",
                    ],
                },
                "alternateContentApi": None,
            },
        )

        self.assertEqual(create_download_plan(blocked)["status"], "blocked")
        self.assertEqual(
            create_download_plan(drive_image)["blockedReasons"],
            ["drive_api_required"],
        )
        self.assertEqual(
            create_download_plan(drive_image)["alternateContentApi"],
            {
                "kind": "drive",
                "required": True,
                "driveFileIdAvailable": True,
                "method": "GET",
                "reason": "Drive-backed Google Chat attachments must be read with the Google Drive API.",
                "auth": {
                    "required": True,
                    "modes": ["user"],
                    "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
                },
            },
        )
        source_only_drive = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/drive-doc",
                "contentName": "roadmap",
                "contentType": "application/vnd.google-apps.document",
                "source": "DRIVE_FILE",
            }
        )
        self.assertEqual(
            create_download_plan(source_only_drive)["blockedReasons"],
            ["drive_api_required"],
        )
        self.assertEqual(
            create_download_plan(source_only_drive)["alternateContentApi"]["kind"],
            "drive",
        )
        self.assertFalse(
            create_download_plan(source_only_drive)["alternateContentApi"][
                "driveFileIdAvailable"
            ]
        )
        self.assertEqual(
            create_download_plan(source_only_drive)["alternateContentApi"]["auth"][
                "scopes"
            ],
            ["https://www.googleapis.com/auth/drive.readonly"],
        )
        self.assertTrue(
            create_download_plan(
                pdf,
                env={
                    "GOOGLE_CHAT_AI_W7_MEDIA_READY": "1",
                    "GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA": "1",
                },
            )["canExecuteLive"]
        )

        self.assertEqual(
            create_upload_plan(
                {
                    "parent": "spaces/AAA",
                    "filename": "../assistant summary.txt",
                    "contentType": "text/plain",
                    "sizeBytes": 3000,
                }
            ),
            {
                "kind": "upload",
                "status": "dry_run",
                "dryRun": True,
                "canExecuteLive": False,
                "liveGate": {
                    "allowed": False,
                    "reasons": ["w7_not_complete", "env_flag_missing"],
                },
                "parent": "spaces/AAA",
                "safeFilename": "assistant_summary.txt",
                "contentType": "text/plain",
                "sizeBytes": 3000,
                "method": "POST",
                "url": "https://chat.googleapis.com/upload/v1/spaces/AAA/attachments:upload?uploadType=multipart",
                "uploadProtocol": "simple",
                "maxBytes": 209715200,
                "policy": {
                    "status": "allowed",
                    "reasons": [],
                },
                "auth": {
                    "required": True,
                    "mode": "user",
                    "scopes": [
                        "https://www.googleapis.com/auth/chat.messages.create",
                        "https://www.googleapis.com/auth/chat.messages",
                        "https://www.googleapis.com/auth/chat.import",
                    ],
                },
            },
        )
        self.assertTrue(
            create_upload_plan(
                {
                    "parent": "spaces/AAA",
                    "filename": "assistant summary.txt",
                    "contentType": "text/plain",
                    "sizeBytes": 3000,
                },
                env={
                    "GOOGLE_CHAT_AI_W7_MEDIA_READY": "1",
                    "GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA": "1",
                },
            )["canExecuteLive"]
        )

    def test_creates_drive_export_plans_for_drive_backed_attachments(self) -> None:
        drive_doc = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/drive-doc",
                "contentName": "roadmap",
                "contentType": "application/vnd.google-apps.document",
                "source": "DRIVE_FILE",
                "driveDataRef": {
                    "driveFileId": "drive-file-123",
                },
            }
        )

        self.assertEqual(
            create_drive_export_plan(drive_doc, target_directory="/tmp/chat-ai-sdk"),
            {
                "kind": "drive_export",
                "status": "dry_run",
                "dryRun": True,
                "canExecuteLive": False,
                "liveGate": {
                    "allowed": False,
                    "reasons": ["env_flag_missing"],
                },
                "attachmentName": "spaces/AAA/messages/root/attachments/drive-doc",
                "contentApi": "drive.files.export",
                "method": "GET",
                "url": "https://www.googleapis.com/drive/v3/files/drive-file-123/export?mimeType=text%2Fplain",
                "driveFileIdAvailable": True,
                "sourceContentType": "application/vnd.google-apps.document",
                "exportMimeType": "text/plain",
                "destinationPath": "/tmp/chat-ai-sdk/roadmap.txt",
                "maxExportBytes": 10485760,
                "policy": {
                    "status": "allowed",
                    "reasons": [],
                },
                "auth": {
                    "required": True,
                    "mode": "user",
                    "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
                },
            },
        )
        self.assertTrue(
            create_drive_export_plan(
                drive_doc, env={"GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE": "1"}
            )["canExecuteLive"]
        )

        source_only_drive = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/drive-doc",
                "contentName": "roadmap",
                "contentType": "application/vnd.google-apps.document",
                "source": "DRIVE_FILE",
            }
        )
        self.assertEqual(
            create_drive_export_plan(source_only_drive)["blockedReasons"],
            ["drive_file_id_missing"],
        )

        uploaded = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/uploaded",
                "contentName": "note.txt",
                "contentType": "text/plain",
                "source": "UPLOADED_CONTENT",
            }
        )
        self.assertEqual(
            create_drive_export_plan(uploaded)["blockedReasons"],
            ["not_drive_backed", "drive_file_id_missing"],
        )

    def test_promotes_drive_rich_links_and_pasted_drive_urls(self) -> None:
        input_data = read_json("fixtures/attachments/drive-link-retrieval.json")
        expected = read_json("fixtures/expected/attachments/drive-link-retrieval.json")

        candidates = collect_drive_link_candidates(input_data["message"])
        self.assertEqual(
            [
                {
                    "source": candidate["source"],
                    "url": candidate["url"],
                    "title": candidate["title"],
                    "driveFileId": candidate["driveFileId"],
                    "driveFileKind": candidate["driveFileKind"],
                    "retrievable": candidate["retrievable"],
                    "blockedReasons": candidate["blockedReasons"],
                }
                for candidate in candidates
            ],
            [
                {
                    "source": "rich_link",
                    "url": "https://docs.google.com/document/d/doc123/edit",
                    "title": "Launch Plan",
                    "driveFileId": "doc123",
                    "driveFileKind": "document",
                    "retrievable": True,
                    "blockedReasons": [],
                },
                {
                    "source": "matched_url",
                    "url": "https://docs.google.com/spreadsheets/d/sheet456/edit#gid=0",
                    "title": None,
                    "driveFileId": "sheet456",
                    "driveFileKind": "spreadsheet",
                    "retrievable": True,
                    "blockedReasons": [],
                },
                {
                    "source": "matched_url",
                    "url": "https://drive.google.com/drive/folders/folder789",
                    "title": None,
                    "driveFileId": "folder789",
                    "driveFileKind": "folder",
                    "retrievable": False,
                    "blockedReasons": ["drive_folder_not_file"],
                },
            ],
        )
        self.assertEqual(create_drive_link_retrieval_plan(input_data), expected)

    def test_handles_raw_annotations_plain_links_and_cached_unavailable_links(self) -> None:
        raw_message = {
            "name": "spaces/AAA/messages/RAW",
            "text": "Review https://docs.google.com/presentation/d/slide999/edit",
            "annotations": [
                {
                    "type": "RICH_LINK",
                    "richLinkMetadata": {
                        "richLinkType": "DRIVE_FILE",
                        "uri": "https://docs.google.com/presentation/d/slide999/edit",
                        "mimeType": "application/vnd.google-apps.presentation",
                        "driveLinkData": {
                            "title": "Launch Deck",
                        },
                    },
                }
            ],
        }

        raw_plan = create_drive_link_retrieval_plan({"message": raw_message})
        self.assertEqual(len(raw_plan["links"]), 1)
        self.assertEqual(
            {
                "source": raw_plan["links"][0]["candidate"]["source"],
                "title": raw_plan["links"][0]["candidate"]["title"],
                "driveFileId": raw_plan["links"][0]["candidate"]["driveFileId"],
                "driveFileKind": raw_plan["links"][0]["candidate"]["driveFileKind"],
                "contentApi": raw_plan["links"][0]["driveExportPlan"]["contentApi"],
                "exportMimeType": raw_plan["links"][0]["driveExportPlan"][
                    "exportMimeType"
                ],
                "destinationPath": raw_plan["links"][0]["driveExportPlan"][
                    "destinationPath"
                ],
                "fallback": raw_plan["links"][0]["fallback"]["action"],
            },
            {
                "source": "rich_link",
                "title": "Launch Deck",
                "driveFileId": "slide999",
                "driveFileKind": "presentation",
                "contentApi": "drive.files.export",
                "exportMimeType": "text/plain",
                "destinationPath": "./Launch_Deck.txt",
                "fallback": "drive_export",
            },
        )

        link_plan = create_drive_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://drive.google.com/file/d/blob123/view",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://drive.google.com/open?id=open456",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/document/d/doc-denied/edit",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/document/u/0/",
                    },
                ],
                "options": {
                    "cache": {
                        "entriesByFileId": {
                            "doc-denied": {
                                "negative": True,
                                "key": "drive-link:doc-denied",
                                "reason": "permission_denied",
                            },
                        },
                    },
                },
            }
        )

        self.assertEqual(
            [
                {
                    "fileId": item["candidate"]["driveFileId"],
                    "kind": item["candidate"]["driveFileKind"],
                    "contentApi": item["driveExportPlan"]["contentApi"]
                    if item["driveExportPlan"]
                    else None,
                    "fallback": item["fallback"]["action"],
                }
                for item in link_plan["links"]
            ],
            [
                {
                    "fileId": "blob123",
                    "kind": "blob",
                    "contentApi": "drive.files.get_media",
                    "fallback": "drive_export",
                },
                {
                    "fileId": "open456",
                    "kind": "blob",
                    "contentApi": "drive.files.get_media",
                    "fallback": "drive_export",
                },
                {
                    "fileId": "doc-denied",
                    "kind": "document",
                    "contentApi": None,
                    "fallback": "cached_unavailable",
                },
                {
                    "fileId": None,
                    "kind": "document",
                    "contentApi": None,
                    "fallback": "metadata_only",
                },
            ],
        )
        self.assertEqual(link_plan["links"][2]["cache"]["status"], "negative_hit")
        self.assertEqual(link_plan["links"][2]["cache"]["reason"], "permission_denied")
        self.assertEqual(link_plan["links"][2]["driveExportPlan"], None)
        self.assertEqual(link_plan["counts"]["candidates"], 4)
        self.assertEqual(link_plan["counts"]["driveExports"], 2)
        self.assertEqual(link_plan["counts"]["blocked"], 2)
        self.assertEqual(link_plan["counts"]["fallbacks"], 2)

    def test_collects_drive_links_from_context_relationships_and_normalized_nodes(
        self,
    ) -> None:
        input_data = read_json("fixtures/attachments/drive-link-context.json")
        expected = read_json("fixtures/expected/attachments/drive-link-context.json")

        self.assertEqual(create_drive_link_retrieval_plan(input_data), expected)

        normalized = normalize_message(
            {
                "name": "spaces/AAA/messages/NORMALIZED",
                "text": "Root message",
                "quotedMessageMetadata": {
                    "message": {
                        "name": "spaces/AAA/messages/NORMALIZED_QUOTE",
                        "text": "Quoted doc https://docs.google.com/document/d/normalizedQuote123/edit",
                    }
                },
            }
        )
        normalized_plan = create_drive_link_retrieval_plan({"message": normalized})
        self.assertEqual(
            [
                {
                    "fileId": item["candidate"]["driveFileId"],
                    "relationship": item["candidate"]["context"]["relationship"],
                    "path": item["candidate"]["context"]["path"],
                }
                for item in normalized_plan["links"]
            ],
            [
                {
                    "fileId": "normalizedQuote123",
                    "relationship": "quoted_message",
                    "path": [
                        "message:spaces/AAA/messages/NORMALIZED",
                        "quoted_message:spaces/AAA/messages/NORMALIZED_QUOTE",
                    ],
                }
            ],
        )

        relationship_wrapper_plan = create_drive_link_retrieval_plan(
            {
                "context": {
                    "children": [
                        {
                            "relationship": "quoted_message",
                            "links": [
                                {
                                    "kind": "plain_url",
                                    "url": "https://docs.google.com/document/d/wrapperLink123/edit",
                                }
                            ],
                            "message": {
                                "name": "spaces/AAA/messages/WRAPPER",
                                "text": "Wrapper message",
                            },
                        }
                    ]
                }
            }
        )
        self.assertEqual(
            relationship_wrapper_plan["links"][0]["candidate"]["context"],
            {
                "messageName": "spaces/AAA/messages/WRAPPER",
                "relationship": "quoted_message",
                "path": [
                    "message:node-1",
                    "quoted_message:spaces/AAA/messages/WRAPPER",
                ],
            },
        )

        nameless_duplicate_plan = create_drive_link_retrieval_plan(
            {
                "context": {
                    "message": {
                        "text": "Root https://docs.google.com/document/d/duplicateDoc123/edit",
                    },
                    "children": [
                        {
                            "relationship": "quoted_message",
                            "message": {
                                "text": "Quote https://docs.google.com/document/d/duplicateDoc123/edit",
                            },
                        }
                    ],
                }
            }
        )
        self.assertEqual(
            [
                item["candidate"]["context"]["path"]
                for item in nameless_duplicate_plan["links"]
            ],
            [
                ["message:node-1"],
                ["message:node-1", "quoted_message:node-2"],
            ],
        )

        cyclic: dict[str, object] = {
            "relationship": "quoted_message",
            "message": {
                "text": "Cycle https://docs.google.com/document/d/cycleDoc123/edit",
            },
        }
        cyclic["children"] = [cyclic]
        cyclic_plan = create_drive_link_retrieval_plan({"context": cyclic})
        self.assertEqual(cyclic_plan["status"], "partial")
        self.assertEqual(
            [item["candidate"]["driveFileId"] for item in cyclic_plan["links"]],
            ["cycleDoc123"],
        )
        self.assertEqual(
            {
                "status": cyclic_plan["traversal"]["status"],
                "truncatedBranches": cyclic_plan["traversal"]["truncatedBranches"],
                "cappedDriveLinks": cyclic_plan["traversal"]["cappedDriveLinks"],
                "cappedPlainTextUrls": cyclic_plan["traversal"]["cappedPlainTextUrls"],
            },
            {
                "status": "truncated",
                "truncatedBranches": 1,
                "cappedDriveLinks": 0,
                "cappedPlainTextUrls": 0,
            },
        )

        deep: dict[str, object] = {
            "message": {
                "text": "Deep https://docs.google.com/document/d/deepDoc123/edit",
            }
        }
        for _ in range(1200):
            deep = {
                "message": {"text": ""},
                "children": [deep],
            }
        deep_plan = create_drive_link_retrieval_plan({"context": deep})
        self.assertEqual(deep_plan["status"], "partial")
        self.assertEqual(deep_plan["links"], [])
        self.assertEqual(
            deep_plan["traversal"],
            {
                "status": "truncated",
                "maxTraversalDepth": 256,
                "maxTraversalNodes": 5000,
                "maxLinkScanItems": 5000,
                "maxDriveLinks": 200,
                "maxPlainTextUrls": 200,
                "truncatedBranches": 1,
                "cappedTraversalNodes": 0,
                "cappedLinkScanItems": 0,
                "cappedDriveLinks": 0,
                "cappedPlainTextUrls": 0,
            },
        )
        self.assertEqual(
            deep_plan["systemNotes"],
            [
                "System Note: Drive link traversal was capped; skipped 1 deep or cyclic branch(es), 0 traversal node(s), 0 link scan item(s), 0 link candidate(s), and 0 plain-text URL(s)."
            ],
        )

    def test_surfaces_drive_link_and_plain_text_url_caps(self) -> None:
        link_cap_plan = create_drive_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/document/d/capDoc1/edit",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/document/d/capDoc2/edit",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/document/d/capDoc3/edit",
                    },
                ],
                "options": {
                    "maxDriveLinks": 2,
                },
            }
        )
        self.assertEqual(link_cap_plan["status"], "partial")
        self.assertEqual(
            [item["candidate"]["driveFileId"] for item in link_cap_plan["links"]],
            ["capDoc1", "capDoc2"],
        )
        self.assertEqual(
            {
                "status": link_cap_plan["traversal"]["status"],
                "maxDriveLinks": link_cap_plan["traversal"]["maxDriveLinks"],
                "cappedDriveLinks": link_cap_plan["traversal"]["cappedDriveLinks"],
                "cappedPlainTextUrls": link_cap_plan["traversal"][
                    "cappedPlainTextUrls"
                ],
                "truncatedBranches": link_cap_plan["traversal"]["truncatedBranches"],
            },
            {
                "status": "truncated",
                "maxDriveLinks": 2,
                "cappedDriveLinks": 1,
                "cappedPlainTextUrls": 0,
                "truncatedBranches": 0,
            },
        )
        self.assertEqual(
            link_cap_plan["systemNotes"][-1],
            "System Note: Drive link traversal was capped; skipped 0 deep or cyclic branch(es), 0 traversal node(s), 0 link scan item(s), 1 link candidate(s), and 0 plain-text URL(s).",
        )

        text_cap_plan = create_drive_link_retrieval_plan(
            {
                "message": {
                    "text": (
                        "One https://docs.google.com/document/d/textDoc1/edit "
                        "two https://docs.google.com/document/d/textDoc2/edit"
                    )
                },
                "options": {
                    "maxPlainTextUrls": 1,
                },
            }
        )
        self.assertEqual(text_cap_plan["status"], "partial")
        self.assertEqual(
            [item["candidate"]["driveFileId"] for item in text_cap_plan["links"]],
            ["textDoc1"],
        )
        self.assertEqual(
            {
                "status": text_cap_plan["traversal"]["status"],
                "maxPlainTextUrls": text_cap_plan["traversal"]["maxPlainTextUrls"],
                "cappedDriveLinks": text_cap_plan["traversal"]["cappedDriveLinks"],
                "cappedPlainTextUrls": text_cap_plan["traversal"][
                    "cappedPlainTextUrls"
                ],
                "truncatedBranches": text_cap_plan["traversal"]["truncatedBranches"],
            },
            {
                "status": "truncated",
                "maxPlainTextUrls": 1,
                "cappedDriveLinks": 0,
                "cappedPlainTextUrls": 1,
                "truncatedBranches": 0,
            },
        )

    def test_bounds_wide_drive_link_scans_and_shallow_context_traversal(
        self,
    ) -> None:
        wide_link_plan = create_drive_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": f"https://docs.google.com/document/d/scanDoc{index}/edit",
                    }
                    for index in range(5)
                ],
                "options": {
                    "maxLinkScanItems": 2,
                },
            }
        )
        self.assertEqual(wide_link_plan["status"], "partial")
        self.assertEqual(
            [item["candidate"]["driveFileId"] for item in wide_link_plan["links"]],
            ["scanDoc0", "scanDoc1"],
        )
        self.assertEqual(
            {
                "status": wide_link_plan["traversal"]["status"],
                "maxLinkScanItems": wide_link_plan["traversal"]["maxLinkScanItems"],
                "cappedLinkScanItems": wide_link_plan["traversal"][
                    "cappedLinkScanItems"
                ],
                "cappedTraversalNodes": wide_link_plan["traversal"][
                    "cappedTraversalNodes"
                ],
                "cappedDriveLinks": wide_link_plan["traversal"]["cappedDriveLinks"],
            },
            {
                "status": "truncated",
                "maxLinkScanItems": 2,
                "cappedLinkScanItems": 3,
                "cappedTraversalNodes": 0,
                "cappedDriveLinks": 0,
            },
        )

        wide_context_plan = create_drive_link_retrieval_plan(
            {
                "context": {
                    "message": {
                        "name": "spaces/AAA/messages/WIDE_ROOT",
                        "text": "Root",
                    },
                    "children": [
                        {
                            "message": {
                                "name": f"spaces/AAA/messages/WIDE_{index}",
                                "text": f"Child https://docs.google.com/document/d/wideDoc{index}/edit",
                            }
                        }
                        for index in range(4)
                    ],
                },
                "options": {
                    "maxTraversalNodes": 3,
                },
            }
        )
        self.assertEqual(wide_context_plan["status"], "partial")
        self.assertEqual(
            [item["candidate"]["driveFileId"] for item in wide_context_plan["links"]],
            ["wideDoc0"],
        )
        self.assertEqual(
            {
                "status": wide_context_plan["traversal"]["status"],
                "maxTraversalNodes": wide_context_plan["traversal"][
                    "maxTraversalNodes"
                ],
                "cappedTraversalNodes": wide_context_plan["traversal"][
                    "cappedTraversalNodes"
                ],
                "cappedLinkScanItems": wide_context_plan["traversal"][
                    "cappedLinkScanItems"
                ],
                "cappedDriveLinks": wide_context_plan["traversal"]["cappedDriveLinks"],
            },
            {
                "status": "truncated",
                "maxTraversalNodes": 3,
                "cappedTraversalNodes": 3,
                "cappedLinkScanItems": 0,
                "cappedDriveLinks": 0,
            },
        )

    def test_drive_link_options_env_and_url_edge_cases(self) -> None:
        input_data = {
            "message": {
                "name": "spaces/AAA/messages/PY_OPTIONS",
                "text": "Plain https://docs.google.com/document/d/plain123/edit",
                "links": [
                    {
                        "kind": "matchedUrl",
                        "url": "https://docs.google.com/spreadsheets/d/matched456/edit",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/presentation/d/plainLink789/edit",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/document/d/e/PUBLISHED_DOC_ID/pub",
                    },
                ],
            }
        }

        self.assertEqual(
            [
                candidate["driveFileId"]
                for candidate in collect_drive_link_candidates(
                    input_data["message"], include_matched_urls=False
                )
            ],
            ["plainLink789", None, "plain123"],
        )
        self.assertEqual(
            [
                candidate["driveFileId"]
                for candidate in collect_drive_link_candidates(
                    input_data["message"], include_plain_text_urls=False
                )
            ],
            ["matched456"],
        )

        plan = create_drive_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/document/d/kwargDoc123/edit",
                    }
                ],
                "options": {"target_directory": "/tmp/nested-drive-links"},
            },
            target_directory="/tmp/kwarg-drive-links",
            export_mime_type="application/pdf",
            enable_live_drive=True,
            cache={
                "entries_by_file_id": {
                    "kwargDoc123": {"key": "drive-link:kwargDoc123"}
                }
            },
        )
        self.assertEqual(
            plan["links"][0]["driveExportPlan"]["destinationPath"],
            "/tmp/kwarg-drive-links/kwargDoc123.pdf",
        )
        self.assertEqual(
            plan["links"][0]["driveExportPlan"]["exportMimeType"],
            "application/pdf",
        )
        self.assertTrue(plan["links"][0]["driveExportPlan"]["canExecuteLive"])
        self.assertEqual(plan["links"][0]["cache"]["key"], "drive-link:kwargDoc123")

        null_target_plan = create_drive_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/document/d/nullTarget123/edit",
                    }
                ],
                "options": {"targetDirectory": None},
            }
        )
        self.assertEqual(
            null_target_plan["links"][0]["driveExportPlan"]["destinationPath"],
            "./nullTarget123.txt",
        )

        with mock.patch.dict(
            os.environ,
            {"GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE": "1"},
            clear=False,
        ):
            env_plan = create_drive_link_retrieval_plan(
                {
                    "links": [
                        {
                            "kind": "plain_url",
                            "url": "https://docs.google.com/document/d/envDoc123/edit",
                        }
                    ]
                }
            )
        self.assertTrue(env_plan["links"][0]["driveExportPlan"]["canExecuteLive"])

        published = create_drive_link_retrieval_plan(input_data)["links"][2]
        self.assertEqual(published["candidate"]["driveFileId"], None)
        self.assertFalse(published["candidate"]["retrievable"])
        self.assertEqual(
            published["candidate"]["blockedReasons"],
            ["published_docs_url_unsupported", "drive_file_id_missing"],
        )
        self.assertEqual(published["driveExportPlan"], None)
        self.assertEqual(published["fallback"]["action"], "metadata_only")

        edge_plan = create_drive_link_retrieval_plan(
            {
                "links": [
                    {
                        "kind": "plain_url",
                        "url": "http://[bad",
                    },
                    {
                        "kind": "plain_url",
                        "url": "https://docs.google.com/forms/d/form123/edit",
                    },
                ]
            }
        )
        self.assertEqual(
            edge_plan["ignoredLinks"],
            [
                {
                    "source": "plain_url",
                    "url": "http://[bad",
                    "reason": "not_google_drive_url",
                    "context": {
                        "messageName": None,
                        "relationship": "message",
                        "path": [],
                    },
                }
            ],
        )
        self.assertEqual(edge_plan["links"][0]["candidate"]["driveFileId"], "form123")
        self.assertEqual(edge_plan["links"][0]["candidate"]["driveFileKind"], "unknown")
        self.assertEqual(
            edge_plan["links"][0]["candidate"]["blockedReasons"],
            ["unsupported_docs_file_kind"],
        )
        self.assertEqual(edge_plan["links"][0]["driveExportPlan"], None)
        self.assertEqual(
            edge_plan["links"][0]["fallback"]["reason"],
            "Drive link points to an unsupported Google Docs editor file kind.",
        )

    def test_plans_high_level_attachment_pipeline(self) -> None:
        from googlechatai import plan_attachment_pipeline as root_plan_attachment_pipeline

        plan = root_plan_attachment_pipeline(
            {
                "context": read_json("fixtures/attachments/context-tree.json"),
                "uploads": [
                    {
                        "parent": "spaces/AAA",
                        "filename": "answer.txt",
                        "contentType": "text/plain",
                        "sizeBytes": 42,
                        "sendOptions": {"hasAccessoryWidgets": True},
                    },
                    {
                        "parent": "spaces/AAA",
                        "filename": "blocked.exe",
                        "contentType": "application/x-msdownload",
                        "sizeBytes": 10,
                    },
                ],
                "options": {
                    "targetDirectory": "/tmp/chat-ai-sdk",
                    "driveExportDirectory": "/tmp/chat-ai-sdk/drive",
                    "cache": {
                        "entriesByAttachmentName": {
                            "spaces/AAA/messages/root/attachments/pdf-1": {
                                "hit": True,
                                "negative": False,
                                "key": "attachment:pdf-hit",
                                "metadata": {"contentSha256": "pdf-sha"},
                            }
                        }
                    },
                    "parsers": {"pdf": "pdf-parse"},
                    "transcription": {"enabled": False},
                },
            }
        )

        self.assertEqual(plan_attachment_pipeline, root_plan_attachment_pipeline)
        self.assertEqual(plan["kind"], "chat.attachment_pipeline_plan")
        self.assertEqual(plan["status"], "partial")
        self.assertEqual(
            plan["counts"],
            {
                "attachments": 4,
                "uploads": 2,
                "downloads": 2,
                "driveExports": 1,
                "blocked": 2,
                "cacheHits": 1,
                "parserReady": 1,
                "transcriptionReady": 0,
                "fallbacks": 5,
            },
        )
        self.assertEqual(
            [item["fallback"]["action"] for item in plan["attachments"]],
            [
                "download_chat_media",
                "metadata_only",
                "transcription_disabled",
                "drive_export_required",
            ],
        )
        self.assertEqual(plan["attachments"][0]["cache"]["status"], "hit")
        self.assertEqual(plan["attachments"][0]["cache"]["key"], "attachment:pdf-hit")
        self.assertEqual(
            plan["attachments"][0]["parsePlan"],
            {
                "status": "ready",
                "mediaKind": "pdf",
                "parser": "pdf-parse",
                "reason": None,
            },
        )
        self.assertEqual(
            plan["attachments"][2]["transcriptionPlan"],
            {
                "status": "disabled",
                "provider": None,
                "model": None,
                "reason": "Audio transcription is disabled by default.",
            },
        )
        self.assertEqual(
            plan["attachments"][3]["driveExportPlan"]["destinationPath"],
            "/tmp/chat-ai-sdk/drive/sketch.png",
        )
        self.assertEqual(
            [item["sendStrategy"]["kind"] for item in plan["uploads"]],
            ["separate_attachment_message", "drive_link_card_fallback"],
        )
        self.assertIn(
            "System Note: Upload answer.txt requires a separate attachment message because Google Chat attachment messages cannot include accessory widgets.",
            plan["systemNotes"],
        )

    def test_pipeline_applies_policy_options_to_recursive_context(self) -> None:
        plan = plan_attachment_pipeline(
            {
                "context": read_json("fixtures/attachments/context-tree.json"),
                "options": {
                    "policy": {"maxDownloadBytes": 1024},
                },
            }
        )

        self.assertEqual(plan["attachments"][0]["attachment"]["policy"]["status"], "blocked")
        self.assertEqual(
            plan["attachments"][0]["attachment"]["policy"]["reasons"],
            ["size_exceeds_download_limit"],
        )
        self.assertEqual(plan["attachments"][0]["fallback"]["status"], "blocked")
        self.assertEqual(plan["attachments"][0]["fallback"]["action"], "metadata_only")

    def test_renders_ai_notes_before_extracted_or_transcribed_status(self) -> None:
        pdf, _, audio, _ = collect_attachments_from_context(
            read_json("fixtures/attachments/context-tree.json")
        )

        parsed = parse_attachment_content(
            pdf,
            "first page text",
            parsers={
                "pdf": lambda attachment, data: {
                    "status": "partial",
                    "parser": "fixture-pdf",
                    "text": str(data),
                    "reason": "Only the first page was available in the fixture.",
                }
            },
        )

        self.assertEqual(
            render_attachment_context_parts(parsed),
            [
                {
                    "type": "system_note",
                    "text": "System Note: The user attached ../Q2 Final?.pdf as Q2_Final_.pdf (application/pdf, 124000 bytes) from UPLOADED_CONTENT in current_message. Extraction status: partial. Transcription status: skipped.",
                },
                {
                    "type": "attachment_content",
                    "status": "partial",
                    "text": "first page text",
                    "note": "Only the first page was available in the fixture.",
                },
            ],
        )

        transcribed = transcribe_audio(audio, b"")
        self.assertEqual(transcribed["processing"]["transcription"]["status"], "disabled")
        self.assertIn(
            "Transcription status: disabled.",
            render_attachment_context_parts(transcribed)[0]["text"],
        )

    def test_blocks_unsafe_parser_input_and_bounds_extracted_attachment_text(self) -> None:
        attachment = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/note",
                "contentName": "note.txt",
                "contentType": "text/plain",
            }
        )
        self.assertIsNotNone(attachment)
        parser = lambda attachment, data: {
            "status": "complete",
            "parser": "fixture-text",
            "text": "abcdefgh",
        }

        scanner_blocked = parse_attachment_content(
            attachment,
            "safe",
            scanner=lambda attachment, data: {"status": "blocked", "reason": "scanner policy"},
            parsers={"text": parser},
        )
        self.assertEqual(scanner_blocked["processing"]["extraction"]["status"], "blocked")
        self.assertEqual(scanner_blocked["processing"]["extraction"]["reason"], "scanner policy")

        input_blocked = parse_attachment_content(
            attachment,
            "too long",
            max_parse_bytes=3,
            parsers={"text": parser},
        )
        self.assertEqual(input_blocked["processing"]["extraction"]["status"], "blocked")

        bounded = parse_attachment_content(
            attachment,
            "safe",
            max_extracted_chars=4,
            parsers={"text": parser},
        )
        self.assertEqual(bounded["processing"]["extraction"]["status"], "partial")
        self.assertEqual(bounded["processing"]["extraction"]["text"], "abcd")
        self.assertIn("truncated at 4", bounded["processing"]["extraction"]["reason"])

    def test_openai_and_gemini_providers_are_optional_and_auth_explicit(self) -> None:
        with self.assertRaisesRegex(
            ValueError, "OpenAI transcription requires an explicit apiKey or client."
        ):
            create_openai_transcription_provider()
        with self.assertRaisesRegex(
            ValueError, "Gemini transcription requires an explicit apiKey or client."
        ):
            create_gemini_transcription_provider()

    def test_transcription_providers_accept_pythonic_keyword_aliases(self) -> None:
        provider = create_openai_transcription_provider(
            api_key="test-key",
            max_bytes=1234,
        )
        self.assertEqual(provider["provider"], "openai")
        self.assertNotIn("apiKey", provider)
        self.assertEqual(provider["maxBytes"], 1234)

        gemini = create_gemini_transcription_provider(
            api_key="gemini-key",
            max_bytes=5678,
        )
        self.assertEqual(gemini["provider"], "gemini")
        self.assertNotIn("apiKey", gemini)
        self.assertEqual(gemini["maxBytes"], 5678)

    def test_transcription_provider_alias_conflicts_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "apiKey and api_key disagree"):
            create_openai_transcription_provider(apiKey="camel", api_key="snake")

        with self.assertRaisesRegex(ValueError, "maxBytes and max_bytes disagree"):
            create_gemini_transcription_provider(
                apiKey="test-key",
                maxBytes=123,
                max_bytes=456,
            )

    def test_openai_transcription_provider_uses_gpt_4o_transcribe(self) -> None:
        audio = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/audio-1",
                "contentName": "voice-note.wav",
                "contentType": "audio/wav",
                "contentSizeBytes": 5,
                "attachmentDataRef": {
                    "resourceName": "spaces/AAA/messages/root/attachments/audio-1/media",
                },
            }
        )
        requests: list[dict[str, str]] = []

        def http_request(**kwargs):
            requests.append(
                {
                    "url": kwargs["url"],
                    "authorization": kwargs["headers"]["authorization"],
                    "model": kwargs["fields"]["model"],
                }
            )
            return {"ok": True, "status": 200, "json": {"text": "hello from audio"}}

        provider = create_openai_transcription_provider(
            apiKey="test-key",
            http_request=http_request,
        )
        transcribed = transcribe_audio(
            audio,
            b"audio",
            enabled=True,
            provider=provider,
        )

        self.assertEqual(provider["model"], "gpt-4o-transcribe")
        self.assertEqual(
            requests,
            [
                {
                    "url": "https://api.openai.com/v1/audio/transcriptions",
                    "authorization": "Bearer test-key",
                    "model": "gpt-4o-transcribe",
                }
            ],
        )
        self.assertEqual(
            transcribed["processing"]["transcription"],
            {
                "status": "complete",
                "provider": "openai",
                "text": "hello from audio",
                "reason": None,
            },
        )
        self.assertEqual(
            summarize_transcription_evidence(
                attachment=audio,
                data=b"audio",
                result=transcribed["processing"]["transcription"],
                include_transcript_text=False,
            ),
            {
                "provider": "openai",
                "model": "gpt-4o-transcribe",
                "status": "complete",
                "audioSha256": "6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b",
                "audioSizeBytes": 5,
                "transcriptLength": 16,
                "transcriptSha256": "e2cb600338632c29a8db6708095bde5628f7bd8b1e59239661dfb9ffac9505af",
                "transcriptText": None,
                "redacted": True,
            },
        )

    def test_gemini_transcription_provider_uses_interactions_api(self) -> None:
        audio = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/audio-1",
                "contentName": "voice-note.wav",
                "contentType": "audio/wav",
                "contentSizeBytes": 5,
                "attachmentDataRef": {
                    "resourceName": "spaces/AAA/messages/root/attachments/audio-1/media",
                },
            }
        )
        requests: list[dict[str, str]] = []

        def http_request(**kwargs):
            requests.append(
                {
                    "url": kwargs["url"],
                    "apiKey": kwargs["headers"]["x-goog-api-key"],
                    "contentType": kwargs["headers"]["content-type"],
                    "model": kwargs["json"]["model"],
                    "prompt": kwargs["json"]["input"][0]["text"],
                    "audioType": kwargs["json"]["input"][1]["type"],
                    "audioMimeType": kwargs["json"]["input"][1]["mime_type"],
                    "audioData": kwargs["json"]["input"][1]["data"],
                }
            )
            return {"ok": True, "status": 200, "json": {"output_text": "hello from gemini"}}

        provider = create_gemini_transcription_provider(
            apiKey="test-key",
            http_request=http_request,
        )
        transcribed = transcribe_audio(
            audio,
            b"audio",
            enabled=True,
            provider=provider,
        )

        self.assertEqual(provider["model"], "gemini-3.5-flash")
        self.assertEqual(
            requests,
            [
                {
                    "url": "https://generativelanguage.googleapis.com/v1beta/interactions",
                    "apiKey": "test-key",
                    "contentType": "application/json",
                    "model": "gemini-3.5-flash",
                    "prompt": "Generate a transcript of the speech. Return only the transcript text.",
                    "audioType": "audio",
                    "audioMimeType": "audio/wav",
                    "audioData": "YXVkaW8=",
                }
            ],
        )
        self.assertEqual(
            transcribed["processing"]["transcription"],
            {
                "status": "complete",
                "provider": "gemini",
                "text": "hello from gemini",
                "reason": None,
            },
        )
        self.assertEqual(
            summarize_transcription_evidence(
                attachment=audio,
                data=b"audio",
                result=transcribed["processing"]["transcription"],
                include_transcript_text=False,
            )["provider"],
            "gemini",
        )

    def test_gemini_transcription_reads_completed_interaction_steps(self) -> None:
        audio = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/audio-1",
                "contentName": "voice-note.wav",
                "contentType": "audio/wav",
                "contentSizeBytes": 5,
            }
        )

        def http_request(**_kwargs):
            return {
                "ok": True,
                "status": 200,
                "json": {
                    "id": "interactions/redacted",
                    "status": "completed",
                    "steps": [
                        {"type": "thought", "signature": "redacted"},
                        {
                            "type": "model_response",
                            "content": [
                                {"type": "text", "text": "hello from gemini steps"}
                            ],
                        },
                    ],
                    "model": "gemini-3.5-flash",
                },
            }

        provider = create_gemini_transcription_provider(
            apiKey="test-key",
            http_request=http_request,
        )
        transcribed = transcribe_audio(
            audio,
            b"audio",
            enabled=True,
            provider=provider,
        )

        self.assertEqual(
            transcribed["processing"]["transcription"],
            {
                "status": "complete",
                "provider": "gemini",
                "text": "hello from gemini steps",
                "reason": None,
            },
        )

    def test_openai_transcription_blocks_oversized_audio(self) -> None:
        audio = normalize_attachment(
            {
                "name": "spaces/AAA/messages/root/attachments/audio-1",
                "contentName": "long.wav",
                "contentType": "audio/wav",
                "contentSizeBytes": 6,
            }
        )
        called = False

        def http_request(**_kwargs):
            nonlocal called
            called = True
            return {"ok": True, "status": 200, "json": {"text": "not used"}}

        provider = create_openai_transcription_provider(
            apiKey="test-key",
            maxBytes=5,
            http_request=http_request,
        )
        result = transcribe_audio(audio, b"123456", enabled=True, provider=provider)

        self.assertFalse(called)
        self.assertEqual(
            result["processing"]["transcription"],
            {
                "status": "blocked",
                "provider": "openai",
                "text": None,
                "reason": "Audio is 6 bytes, exceeding the configured transcription limit of 5 bytes.",
            },
        )


if __name__ == "__main__":
    unittest.main()
