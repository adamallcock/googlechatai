"""Stable typed contracts for Python SDK consumers.

The runtime remains JSON/dictionary oriented for shared Node/Python conformance.
These TypedDict and Protocol definitions provide an additive, native Python
surface without changing the wire-compatible runtime values.
"""

from __future__ import annotations

from typing import Literal, Mapping, Protocol, TypedDict, runtime_checkable

from .transport import IdempotencyClaim, IdempotencyStore

TrustLevel = Literal["trusted", "untrusted"]
IdentityAccessStatus = Literal["available", "access_limited"]


class IdentityAccess(TypedDict):
    status: IdentityAccessStatus
    reason: str | None


class ChatUser(TypedDict, total=False):
    name: str
    displayName: str | None
    email: str | None
    type: str | None
    isApp: bool
    access: IdentityAccess


class ChatSpace(TypedDict, total=False):
    name: str
    displayName: str | None
    type: str | None
    spaceType: str | None


class ChatThread(TypedDict, total=False):
    name: str
    threadKey: str | None


class ChatMessage(TypedDict, total=False):
    name: str
    text: str
    argumentText: str
    sender: ChatUser
    createTime: str
    thread: ChatThread


class _RequiredChatEventEnvelope(TypedDict):
    eventId: str
    idempotencyKey: str
    kind: str
    source: str


class ChatEventEnvelope(_RequiredChatEventEnvelope, total=False):
    rawKind: str | None
    occurredAt: str | None
    sender: ChatUser | None
    space: ChatSpace | None
    thread: ChatThread | None
    message: ChatMessage | None
    transport: Mapping[str, object]


class ModelContextFragment(TypedDict):
    """One runtime fragment emitted by ``project_model_context``."""

    type: str
    text: str | None
    trust: TrustLevel
    provenance: str
    truncated: bool
    metadata: Mapping[str, object] | None


class ModelContextProjectionState(TypedDict):
    truncated: bool
    maxFragments: int
    maxTotalTextChars: int
    maxQuoteDepth: int
    emittedFragments: int
    emittedTextChars: int
    omittedFragments: int
    quoteDepthLimited: bool


class ModelContextSourceState(TypedDict):
    partial: bool
    truncated: bool
    inaccessible: bool


class ModelContextProjection(TypedDict):
    kind: Literal["chat.model_context"]
    schemaVersion: Literal[1]
    sourceState: ModelContextSourceState
    projection: ModelContextProjectionState
    fragments: list[ModelContextFragment]


@runtime_checkable
class ModelContextProjector(Protocol):
    """Callable shape for an application wrapper around model-safe context."""

    def __call__(
        self,
        context: Mapping[str, object],
        /,
        **options: object,
    ) -> ModelContextProjection: ...


__all__ = [
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
]
