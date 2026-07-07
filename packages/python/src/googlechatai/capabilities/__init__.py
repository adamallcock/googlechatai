"""Google Chat capability and error explainers."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any


JsonObject = dict[str, Any]

CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot"
CHAT_MESSAGES_READONLY_SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly"
CHAT_REACTIONS_SCOPE = "https://www.googleapis.com/auth/chat.messages.reactions"
CHAT_REACTIONS_READONLY_SCOPE = (
    "https://www.googleapis.com/auth/chat.messages.reactions.readonly"
)
CHAT_MEMBERSHIPS_READONLY_SCOPE = (
    "https://www.googleapis.com/auth/chat.memberships.readonly"
)
CHAT_CUSTOM_EMOJIS_READONLY_SCOPE = (
    "https://www.googleapis.com/auth/chat.customemojis.readonly"
)
CHAT_USERS_READSTATE_SCOPE = (
    "https://www.googleapis.com/auth/chat.users.readstate.readonly"
)
CHAT_USERS_SPACESETTINGS_SCOPE = (
    "https://www.googleapis.com/auth/chat.users.spacesettings"
)
CHAT_USERS_SECTIONS_SCOPE = "https://www.googleapis.com/auth/chat.users.sections"
CHAT_APP_SPACES_CREATE_SCOPE = "https://www.googleapis.com/auth/chat.app.spaces.create"
DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
WORKSPACE_EVENTS_SCOPE = "https://www.googleapis.com/auth/workspace.events"

REACTION_USER_AUTH_REMEDIATION = [
    f"Use the submitting user's OAuth token with {CHAT_REACTIONS_SCOPE}.",
    "Keep visible feedback reactions user-owned; do not silently create them as the app.",
]


CAPABILITIES: list[JsonObject] = [
    {
        "intent": "messages.send",
        "aliases": ["spaces.messages.create"],
        "googleMethod": "spaces.messages.create",
        "defaultPrincipal": "app",
        "supportedPrincipals": ["app", "user"],
        "requiredScopes": [CHAT_BOT_SCOPE],
        "adminApproval": "not_required",
        "membership": "app_must_be_member",
        "readWriteRisk": "write",
        "idempotency": "request_id_or_client_message_id_recommended",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
    },
    {
        "intent": "messages.reply",
        "googleMethod": "spaces.messages.create",
        "defaultPrincipal": "app",
        "supportedPrincipals": ["app"],
        "requiredScopes": [CHAT_BOT_SCOPE],
        "adminApproval": "not_required",
        "membership": "app_must_be_member",
        "readWriteRisk": "write",
        "idempotency": "request_id_or_client_message_id_recommended",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
    },
    {
        "intent": "messages.edit_app_created",
        "aliases": ["spaces.messages.patch"],
        "googleMethod": "spaces.messages.patch",
        "defaultPrincipal": "app",
        "supportedPrincipals": ["app"],
        "requiredScopes": [CHAT_BOT_SCOPE],
        "adminApproval": "not_required",
        "membership": "app_must_be_member",
        "readWriteRisk": "write",
        "idempotency": "target_resource_idempotent",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
        "knownLimitations": ["Only edit messages created by the same Chat app."],
    },
    {
        "intent": "messages.delete_app_created",
        "aliases": ["spaces.messages.delete"],
        "googleMethod": "spaces.messages.delete",
        "defaultPrincipal": "app",
        "supportedPrincipals": ["app"],
        "requiredScopes": [CHAT_BOT_SCOPE],
        "adminApproval": "not_required",
        "membership": "app_must_be_member",
        "readWriteRisk": "write",
        "idempotency": "target_resource_idempotent",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
        "knownLimitations": ["Only delete messages created by the same Chat app."],
    },
    {
        "intent": "messages.read_context",
        "aliases": ["spaces.messages.list"],
        "googleMethod": "spaces.messages.list",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_MESSAGES_READONLY_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "read",
        "idempotency": "read_only",
        "retryPolicy": "retry_reads",
        "liveSafe": True,
    },
    {
        "intent": "messages.stream_edit",
        "googleMethod": "spaces.messages.patch",
        "defaultPrincipal": "app",
        "supportedPrincipals": ["app"],
        "requiredScopes": [CHAT_BOT_SCOPE],
        "adminApproval": "not_required",
        "membership": "app_must_be_member",
        "readWriteRisk": "write",
        "idempotency": "ordered_patch_target_resource",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
    },
    {
        "intent": "attachments.upload",
        "aliases": ["media.upload"],
        "googleMethod": "media.upload",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_MESSAGES_READONLY_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "write",
        "idempotency": "upload_token_required",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
        "knownLimitations": ["Attachment messages cannot include accessory widgets."],
    },
    {
        "intent": "attachments.download",
        "aliases": ["media.download"],
        "googleMethod": "media.download",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_MESSAGES_READONLY_SCOPE, DRIVE_READONLY_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "read",
        "idempotency": "read_only",
        "retryPolicy": "retry_reads",
        "liveSafe": True,
    },
    {
        "intent": "reactions.add",
        "aliases": ["spaces.messages.reactions.create"],
        "googleMethod": "spaces.messages.reactions.create",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_REACTIONS_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "write",
        "idempotency": "not_idempotent",
        "retryPolicy": "retry_reads_or_idempotent_writes_only",
        "liveSafe": False,
        "knownLimitations": [
            "Google Chat reactions are visible as the reacting user and should not be created with app auth."
        ],
        "unsupportedPrincipalRemediation": REACTION_USER_AUTH_REMEDIATION,
    },
    {
        "intent": "reactions.list",
        "aliases": ["spaces.messages.reactions.list"],
        "googleMethod": "spaces.messages.reactions.list",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_REACTIONS_READONLY_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "read",
        "idempotency": "read_only",
        "retryPolicy": "retry_reads",
        "liveSafe": True,
    },
    {
        "intent": "reactions.delete",
        "aliases": ["spaces.messages.reactions.delete"],
        "googleMethod": "spaces.messages.reactions.delete",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_REACTIONS_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "write",
        "idempotency": "target_resource_idempotent",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
        "unsupportedPrincipalRemediation": REACTION_USER_AUTH_REMEDIATION,
    },
    {
        "intent": "memberships.list",
        "aliases": ["spaces.members.list"],
        "googleMethod": "spaces.members.list",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user", "app"],
        "requiredScopes": [CHAT_MEMBERSHIPS_READONLY_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "caller_must_have_access",
        "readWriteRisk": "read",
        "idempotency": "read_only",
        "retryPolicy": "retry_reads",
        "liveSafe": True,
    },
    {
        "intent": "custom_emojis.list",
        "aliases": ["customEmojis.list"],
        "googleMethod": "customEmojis.list",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_CUSTOM_EMOJIS_READONLY_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "not_required",
        "readWriteRisk": "read",
        "idempotency": "read_only",
        "retryPolicy": "retry_reads",
        "liveSafe": True,
    },
    {
        "intent": "users.read_state",
        "googleMethod": "users.spaces.getSpaceReadState",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_USERS_READSTATE_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "read",
        "idempotency": "read_only",
        "retryPolicy": "retry_reads",
        "liveSafe": True,
    },
    {
        "intent": "users.notification_settings",
        "googleMethod": "users.spaces.spaceNotificationSetting.get",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_USERS_SPACESETTINGS_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "read_write",
        "idempotency": "target_resource_idempotent",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
    },
    {
        "intent": "users.sections",
        "googleMethod": "users.sections.list",
        "defaultPrincipal": "user",
        "supportedPrincipals": ["user"],
        "requiredScopes": [CHAT_USERS_SECTIONS_SCOPE],
        "adminApproval": "user_consent_required",
        "membership": "user_must_have_access",
        "readWriteRisk": "read_write",
        "idempotency": "target_resource_idempotent",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
    },
    {
        "intent": "workspace_events.subscribe",
        "aliases": ["subscriptions.create"],
        "googleMethod": "subscriptions.create",
        "defaultPrincipal": "admin",
        "supportedPrincipals": ["admin"],
        "requiredScopes": [WORKSPACE_EVENTS_SCOPE],
        "adminApproval": "admin_required",
        "membership": "target_resource_policy_required",
        "readWriteRisk": "write",
        "idempotency": "subscription_id_required",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
        "knownLimitations": [
            "Workspace Events Pub/Sub publisher IAM can be blocked by tenant org policy."
        ],
    },
    {
        "intent": "card_interactions.respond",
        "googleMethod": "chat.webhook.response",
        "defaultPrincipal": "none",
        "supportedPrincipals": ["none"],
        "requiredScopes": [],
        "adminApproval": "not_required",
        "membership": "app_must_be_configured",
        "readWriteRisk": "none",
        "idempotency": "event_idempotency_key_required_before_side_effects",
        "retryPolicy": "do_not_retry_after_chat_deadline",
        "liveSafe": True,
    },
    {
        "intent": "spaces.create_app",
        "googleMethod": "spaces.create",
        "defaultPrincipal": "app",
        "supportedPrincipals": ["app"],
        "requiredScopes": [CHAT_BOT_SCOPE, CHAT_APP_SPACES_CREATE_SCOPE],
        "adminApproval": "workspace_admin_may_be_required",
        "membership": "not_required",
        "readWriteRisk": "write",
        "idempotency": "request_id_required",
        "retryPolicy": "retry_replay_safe_only",
        "liveSafe": False,
    },
]


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _find_record(intent_or_method: str) -> JsonObject:
    normalized = intent_or_method.strip()
    for record in CAPABILITIES:
        if (
            record["intent"] == normalized
            or record["googleMethod"] == normalized
            or normalized in record.get("aliases", [])
        ):
            return dict(record)

    return {
        "intent": normalized,
        "googleMethod": normalized,
        "defaultPrincipal": "user",
        "supportedPrincipals": ["app", "user"],
        "requiredScopes": [],
        "adminApproval": "unknown",
        "membership": "unknown",
        "readWriteRisk": "unknown",
        "idempotency": "unknown",
        "retryPolicy": "unknown",
        "liveSafe": False,
        "knownLimitations": ["No curated Google Chat capability record exists yet."],
    }


def _requested_principal(options: Mapping[str, Any], default: str) -> str:
    principal = _as_string(options.get("principal")) or default
    return principal if principal in {"app", "user", "admin", "none"} else "user"


def _capability_explanation(
    kind: str,
    intent_or_method: str,
    options: Mapping[str, Any] | None = None,
) -> JsonObject:
    opts = options or {}
    record = _find_record(intent_or_method)
    requested = _requested_principal(opts, str(record["defaultPrincipal"]))
    supported = requested in record["supportedPrincipals"]

    return {
        "kind": kind,
        "intent": record["intent"],
        "googleMethod": record["googleMethod"],
        "ok": supported,
        "status": "available" if supported else "unavailable",
        "principal": requested,
        "requestedPrincipal": requested,
        "supportedPrincipals": record["supportedPrincipals"],
        "requiredScopes": record["requiredScopes"],
        "adminApproval": record["adminApproval"],
        "membership": record["membership"],
        "readWriteRisk": record["readWriteRisk"],
        "idempotency": record["idempotency"],
        "retryPolicy": record["retryPolicy"],
        "liveSafe": record["liveSafe"],
        "knownLimitations": record.get("knownLimitations", []),
        "reasons": [] if supported else ["unsupported_principal"],
        "remediation": []
        if supported
        else record.get(
            "unsupportedPrincipalRemediation",
            [
                "Use one of the supported principals: "
                + ", ".join(record["supportedPrincipals"])
                + "."
            ],
        ),
    }


def explain_chat_capability(
    intent_or_method: str,
    options: Mapping[str, Any] | None = None,
) -> JsonObject:
    return _capability_explanation(
        "chat.capability_explanation",
        intent_or_method,
        options,
    )


def plan_chat_permission(
    intent_or_method: str,
    options: Mapping[str, Any] | None = None,
) -> JsonObject:
    return _capability_explanation("chat.permission_plan", intent_or_method, options)


def _http_status(error: Mapping[str, Any]) -> int | None:
    response = _as_mapping(error.get("response")) or {}
    status = (
        _as_number(error.get("httpStatus"))
        or _as_number(error.get("status"))
        or _as_number(response.get("status"))
    )
    return int(status) if status is not None else None


def _lower_headers(error: Mapping[str, Any]) -> dict[str, str]:
    response = _as_mapping(error.get("response")) or {}
    headers = _as_mapping(error.get("headers")) or _as_mapping(response.get("headers")) or {}
    return {str(key).lower(): str(value) for key, value in headers.items()}


def _google_error(error: Mapping[str, Any]) -> Mapping[str, Any]:
    body = _as_mapping(error.get("body")) or {}
    json_body = _as_mapping(error.get("json")) or {}
    return (
        _as_mapping(body.get("error"))
        or _as_mapping(json_body.get("error"))
        or _as_mapping(error.get("error"))
        or {}
    )


def _debug_for(google: Mapping[str, Any]) -> JsonObject:
    message = _as_string(google.get("message")) or ""
    return {
        "redacted": True,
        "googleStatus": _as_string(google.get("status")),
        "messageLength": len(message),
    }


def _parse_retry_after_ms(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return max(0, int(float(value) * 1000))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            delay = retry_at - datetime.now(retry_at.tzinfo)
            return max(0, int(delay.total_seconds() * 1000))
        except (TypeError, ValueError, OverflowError):
            return None


def explain_google_chat_error(
    error: Mapping[str, Any],
    context: Mapping[str, Any] | None = None,
) -> JsonObject:
    ctx = context or {}
    status = _http_status(error)
    google = _google_error(error)
    message = _as_string(google.get("message")) or _as_string(error.get("message")) or ""
    google_status = _as_string(google.get("status")) or ""
    principal = _as_string(ctx.get("principal"))
    intent = _as_string(ctx.get("intent"))
    required_scopes = ctx.get("requiredScopes")
    first_scope = (
        required_scopes[0]
        if isinstance(required_scopes, list) and required_scopes
        else None
    )

    if status == 403 and ("scope" in message.lower() or "insufficient" in message.lower()):
        return {
            "kind": "chat.error_explanation",
            "code": "insufficient_scopes",
            "category": "permission",
            "httpStatus": 403,
            "retryable": False,
            "principal": principal,
            "intent": intent,
            "summary": "The user token is missing a required Google Chat scope.",
            "remediation": [
                "Re-run installed-user OAuth consent"
                + (f" with {first_scope}" if first_scope else "")
                + ".",
                "Keep this on the installed-user path; do not switch to domain-wide delegation by default.",
            ],
            "debug": _debug_for(google),
        }

    if status == 429:
        headers = _lower_headers(error)
        return {
            "kind": "chat.error_explanation",
            "code": "rate_limited",
            "category": "rate_limit",
            "httpStatus": 429,
            "retryable": True,
            "retryAfterMs": _parse_retry_after_ms(headers.get("retry-after")),
            "principal": principal,
            "intent": intent,
            "summary": "Google Chat rate limited the request.",
            "remediation": [
                "Retry after the Retry-After delay with the central retry policy.",
                "Do not replay unsafe writes unless the request has a stable idempotency key.",
            ],
            "debug": _debug_for(google),
        }

    if status == 401:
        return {
            "kind": "chat.error_explanation",
            "code": "auth_required",
            "category": "auth",
            "httpStatus": 401,
            "retryable": False,
            "principal": principal,
            "intent": intent,
            "summary": "Google Chat requires fresh authorization.",
            "remediation": [
                "Refresh the access token silently when possible.",
                "If refresh is unavailable, ask the installing user to authorize the required scopes.",
            ],
            "debug": _debug_for(google),
        }

    if status == 404:
        return {
            "kind": "chat.error_explanation",
            "code": "resource_not_found"
            if "not" in f"{google_status} {message}".lower()
            else "app_not_configured",
            "category": "not_found",
            "httpStatus": 404,
            "retryable": False,
            "principal": principal,
            "intent": intent,
            "summary": "Google Chat could not find the requested app, method, or resource.",
            "remediation": [
                "Verify the Cloud project, Chat app configuration, smoke-space membership, and endpoint availability."
            ],
            "debug": _debug_for(google),
        }

    if status == 409:
        return {
            "kind": "chat.error_explanation",
            "code": "conflict",
            "category": "google_api",
            "httpStatus": 409,
            "retryable": False,
            "principal": principal,
            "intent": intent,
            "summary": "Google Chat reported a conflict.",
            "remediation": [
                "Check whether the idempotency key or target resource was already used."
            ],
            "debug": _debug_for(google),
        }

    if status is not None and status >= 500:
        return {
            "kind": "chat.error_explanation",
            "code": "google_transient",
            "category": "google_api",
            "httpStatus": status,
            "retryable": True,
            "principal": principal,
            "intent": intent,
            "summary": "Google Chat returned a retryable server error.",
            "remediation": [
                "Retry with exponential backoff when the operation is replay-safe."
            ],
            "debug": _debug_for(google),
        }

    if status == 400:
        return {
            "kind": "chat.error_explanation",
            "code": "invalid_request",
            "category": "validation",
            "httpStatus": 400,
            "retryable": False,
            "principal": principal,
            "intent": intent,
            "summary": "Google Chat rejected the request shape.",
            "remediation": [
                "Validate the request body, response envelope, card surface, and required fields."
            ],
            "debug": _debug_for(google),
        }

    return {
        "kind": "chat.error_explanation",
        "code": "unknown",
        "category": "unknown",
        "httpStatus": status,
        "retryable": False,
        "principal": principal,
        "intent": intent,
        "summary": "The Google Chat failure did not match a curated SDK category.",
        "remediation": [
            "Inspect the redacted debug metadata and rerun the narrow smoke command."
        ],
        "debug": _debug_for(google),
    }
