"""Runtime router for Google Chat event handlers."""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from googlechatai.events import normalize_event
from googlechatai.transport import (
    IdempotencyStore,
    guard_duplicate_event_delivery,
)

from .context import ContextLoader, HandlerContext
from .replies import ChatResponse, json_response, normalize_handler_response


HandlerResult = str | Mapping[str, Any] | ChatResponse | None
Handler = Callable[[HandlerContext], HandlerResult | Awaitable[HandlerResult]]
Predicate = Callable[[Mapping[str, Any]], bool]

# Deadline-managed delivery must not let an arbitrary number of synchronous
# handlers or durable-store calls create threads. Work that cannot be
# cancelled (for example a blocking application callback) is bounded globally
# and runs on this shared executor; overload is surfaced to the HTTP boundary
# for a retry instead of silently accepting an unprotected delivery.
_BLOCKING_WORKERS = 8
_BLOCKING_WORK_CAPACITY = 16
_blocking_executor = ThreadPoolExecutor(
    max_workers=_BLOCKING_WORKERS,
    thread_name_prefix="googlechatai-blocking",
)
_blocking_work_slots = threading.BoundedSemaphore(_BLOCKING_WORK_CAPACITY)

_deadline_supervisor_lock = threading.Lock()
_deadline_supervisor_loop: asyncio.AbstractEventLoop | None = None
_deadline_supervisor_thread: threading.Thread | None = None


class DeliveryCapacityError(RuntimeError):
    """A retryable inbound delivery could not enter bounded blocking work."""


class _BlockingWorkSaturatedError(DeliveryCapacityError):
    """Raised when bounded off-loop work cannot be admitted safely."""


def _sync_deadline_supervisor_loop() -> asyncio.AbstractEventLoop:
    """Return the one daemon loop that preserves late sync-dispatch work.

    ``dispatch()`` cannot use ``asyncio.run`` when a deadline deliberately
    leaves an async handler running for late-result logging: ``asyncio.run``
    cancels that task on return. A single long-lived supervisor prevents the
    old one-thread/one-loop-per-delivery leak while retaining that behavior.
    """

    global _deadline_supervisor_loop, _deadline_supervisor_thread
    with _deadline_supervisor_lock:
        if (
            _deadline_supervisor_loop is not None
            and _deadline_supervisor_thread is not None
            and _deadline_supervisor_thread.is_alive()
        ):
            return _deadline_supervisor_loop

        loop = asyncio.new_event_loop()
        ready = threading.Event()

        def runner() -> None:
            asyncio.set_event_loop(loop)
            ready.set()
            loop.run_forever()

        thread = threading.Thread(
            target=runner,
            name="googlechatai-deadline-supervisor",
            daemon=True,
        )
        _deadline_supervisor_loop = loop
        _deadline_supervisor_thread = thread
        thread.start()
        ready.wait()
        return loop


async def _run_bounded_blocking(
    function: Callable[..., Any],
    /,
    *args: Any,
    **kwargs: Any,
) -> Any:
    """Execute unavoidable synchronous work off the active event loop.

    The semaphore bounds both running and queued work. A blocking handler may
    outlive the Chat deadline, but it cannot cause an unbounded thread or work
    queue build-up under repeated deliveries.
    """

    if not _blocking_work_slots.acquire(blocking=False):
        raise _BlockingWorkSaturatedError(
            "Google Chat synchronous work capacity is exhausted."
        )

    def invoke() -> Any:
        try:
            return function(*args, **kwargs)
        finally:
            _blocking_work_slots.release()

    loop = asyncio.get_running_loop()
    try:
        future = loop.run_in_executor(_blocking_executor, invoke)
    except BaseException:
        _blocking_work_slots.release()
        raise
    # A cancelled waiter must not cancel a queued executor callback: if it did,
    # `invoke()` would never run and the reserved semaphore slot would leak.
    # The work itself remains bounded and releases its slot exactly once.
    return await asyncio.shield(future)


KNOWN_EVENT_KINDS: frozenset[str] = frozenset(
    {
        "message.created",
        "message.updated",
        "message.deleted",
        "message.mentioned_app",
        "message.direct",
        "message.thread_reply",
        "message.slash_command",
        "message.app_command",
        "message.link_preview_requested",
        "message.unknown_command",
        "space.added",
        "space.removed",
        "space.updated",
        "space.deleted",
        "membership.created",
        "membership.updated",
        "membership.deleted",
        "reaction.created",
        "reaction.deleted",
        "card.clicked",
        "dialog.opened",
        "dialog.submitted",
        "dialog.cancelled",
        "widget.updated",
        "event.batch",
        "event.unknown",
    }
)


@dataclass(frozen=True)
class _HandlerRegistration:
    name: str
    predicate: Predicate
    handler: Handler


@dataclass(frozen=True)
class _SlashCommandRegistration:
    command_name: str | None
    handler: Handler


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _first(handlers: Any) -> Handler | None:
    """Return the first handler in an iterable, or ``None`` if it is empty."""

    for handler in handlers:
        return handler
    return None


def _is_mention_of_app(
    event: Mapping[str, Any],
    app_user: Mapping[str, Any] | None,
) -> bool:
    if not app_user:
        return False

    message = event.get("message")
    if not isinstance(message, Mapping):
        return False

    app_user_name = app_user.get("name")
    if not app_user_name:
        return False

    for annotation in message.get("annotations", []):
        if not isinstance(annotation, Mapping) or annotation.get("kind") != "userMention":
            continue

        user = _as_mapping(annotation.get("user")) or {}
        if user.get("resourceName") == app_user_name or user.get("name") == app_user_name:
            return True

    return False


def _route_kind_for_raw_payload(
    event: Mapping[str, Any],
    raw_payload: Any,
    app_user: Mapping[str, Any] | None,
) -> str:
    raw = _as_mapping(raw_payload) or {}
    raw_type = _as_string(raw.get("type"))
    dialog_event_type = _as_string(raw.get("dialogEventType"))

    if raw_type == "DIALOG_SUBMITTED" or dialog_event_type in {
        "SUBMIT_DIALOG",
        "SUBMITTED",
    }:
        return "dialog.submitted"

    if event.get("kind") in {
        "message.created",
        "message.direct",
        "message.thread_reply",
    } and _is_mention_of_app(event, app_user):
        return "message.mentioned_app"

    return event["kind"]


def _adapt_event_for_router(
    event: dict[str, Any],
    raw_payload: Any,
    app_user: Mapping[str, Any] | None,
) -> dict[str, Any]:
    kind = _route_kind_for_raw_payload(event, raw_payload, app_user)
    if kind == event["kind"]:
        return event
    adjusted = dict(event)
    adjusted["kind"] = kind
    return adjusted


def _normalize_slash_command_name(name: str) -> str:
    trimmed = name[1:] if name.startswith("/") else name
    return trimmed.strip().lower()


def _slash_command_name_for_event(event: Mapping[str, Any]) -> str | None:
    message = _as_mapping(event.get("message")) or {}
    slash_command = _as_mapping(message.get("slashCommand")) or {}
    command_name = _as_string(slash_command.get("commandName"))
    if command_name:
        return _normalize_slash_command_name(command_name)

    # The normalized annotations don't always carry commandName (only a
    # matching `slashCommand`-kind annotation populates it). Fall back to the
    # first token of the raw message text, which for a slash command is
    # always "/commandName"; argumentText only holds the text *after* the
    # command and can never contain the command name itself.
    fallback_text = _as_string(message.get("text")) or _as_string(
        message.get("argumentText")
    )
    if not fallback_text:
        return None
    tokens = fallback_text.strip().split()
    return _normalize_slash_command_name(tokens[0]) if tokens else None


def _normalize_dedupe_option(
    dedupe: Any,
) -> tuple[IdempotencyStore, int | None, bool] | None:
    if dedupe is None:
        return None

    if isinstance(dedupe, IdempotencyStore):
        return dedupe, None, bool(getattr(dedupe, "requires_thread_offload", False))

    if isinstance(dedupe, Mapping):
        store = dedupe.get("store")
        if not isinstance(store, IdempotencyStore):
            raise TypeError(
                "dedupe requires a 'store' entry that is an IdempotencyStore."
            )
        ttl_ms = dedupe.get("ttl_ms")
        configured_offload = dedupe.get("offload_sync")
        if configured_offload is not None and not isinstance(configured_offload, bool):
            raise TypeError("dedupe 'offload_sync' must be a boolean when provided.")
        return (
            store,
            ttl_ms,
            bool(
                configured_offload
                if configured_offload is not None
                else getattr(store, "requires_thread_offload", False)
            ),
        )

    raise TypeError(
        "dedupe must be a mapping with a 'store' entry, or an IdempotencyStore."
    )


@dataclass
class _DeadlineOption:
    budget_ms: int
    on_deadline: Handler | None = None


def _normalize_deadline_option(deadline: Any) -> _DeadlineOption | None:
    if deadline is None:
        return None

    if isinstance(deadline, Mapping):
        budget_ms = deadline.get("budget_ms")
        if not isinstance(budget_ms, int) or budget_ms <= 0:
            raise TypeError("deadline requires a positive integer 'budget_ms'.")
        return _DeadlineOption(
            budget_ms=budget_ms,
            on_deadline=deadline.get("on_deadline"),
        )

    raise TypeError("deadline must be a mapping with a 'budget_ms' entry.")


class GoogleChatAI:
    """Register and dispatch Google Chat event handlers.

    The runtime accepts local fixture or HTTP payload dictionaries, normalizes
    them with ``normalize_event``, and passes a ``HandlerContext`` to handlers.
    It does not perform live Google Chat API writes.
    """

    def __init__(
        self,
        *,
        context_loader: Any | None = None,
        logger: logging.Logger | None = None,
        reply_routing: Mapping[str, Any] | None = None,
        raise_handler_errors: bool = False,
        error_response: Mapping[str, Any] | None = None,
        app_user: Mapping[str, Any] | None = None,
        dedupe: Mapping[str, Any] | IdempotencyStore | None = None,
        deadline: Mapping[str, Any] | None = None,
    ) -> None:
        self._handlers: list[_HandlerRegistration] = []
        self._unknown_handler: Handler | None = None
        self._mention_handlers: list[Handler] = []
        self._message_handlers: list[Handler] = []
        self._slash_command_handlers: list[_SlashCommandRegistration] = []
        self._generic_handlers: dict[str, list[Handler]] = {}
        self._context_loader = context_loader or ContextLoader()
        self._logger = logger or logging.getLogger("googlechatai.router")
        self._reply_routing = dict(reply_routing or {})
        self._raise_handler_errors = raise_handler_errors
        self._error_response = dict(error_response or {})
        self._app_user = dict(app_user) if app_user is not None else None
        self._dedupe = _normalize_dedupe_option(dedupe)
        self._deadline = _normalize_deadline_option(deadline)

    def on_message(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        # Deliberately not routed through the generic `_handlers` predicate
        # list: onMessage is the family-of-last-resort fallback for any
        # message.* kind, consulted by `_resolve_handler` only after every
        # more specific registration (dedicated on_*, named slash command,
        # generic on(kind)) has been checked.
        def register(fn: Handler) -> Handler:
            self._message_handlers.append(fn)
            return fn

        if handler is not None:
            return register(handler)
        return register

    def on_mention(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        def register(fn: Handler) -> Handler:
            self._mention_handlers.append(fn)
            return fn

        if handler is not None:
            return register(handler)
        return register

    def on_card_clicked(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_card_clicked",
            lambda event: event.get("kind") == "card.clicked",
            handler,
        )

    def on_dialog_submitted(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_dialog_submitted",
            lambda event: event.get("kind") == "dialog.submitted",
            handler,
        )

    def on_dialog_cancelled(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_dialog_cancelled",
            lambda event: event.get("kind") == "dialog.cancelled",
            handler,
        )

    def on_widget_updated(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_widget_updated",
            lambda event: event.get("kind") == "widget.updated",
            handler,
        )

    def on_link_preview(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_link_preview",
            lambda event: event.get("kind") == "message.link_preview_requested",
            handler,
        )

    def on_added_to_space(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_added_to_space",
            lambda event: event.get("kind") == "space.added",
            handler,
        )

    def on_removed_from_space(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_removed_from_space",
            lambda event: event.get("kind") == "space.removed",
            handler,
        )

    def on_reaction_created(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_reaction_created",
            lambda event: event.get("kind") == "reaction.created",
            handler,
        )

    def on_reaction_deleted(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_reaction_deleted",
            lambda event: event.get("kind") == "reaction.deleted",
            handler,
        )

    def on_membership_created(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_membership_created",
            lambda event: event.get("kind") == "membership.created",
            handler,
        )

    def on_membership_updated(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_membership_updated",
            lambda event: event.get("kind") == "membership.updated",
            handler,
        )

    def on_membership_deleted(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_membership_deleted",
            lambda event: event.get("kind") == "membership.deleted",
            handler,
        )

    def on_message_updated(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_message_updated",
            lambda event: event.get("kind") == "message.updated",
            handler,
        )

    def on_message_deleted(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        return self._decorate(
            "on_message_deleted",
            lambda event: event.get("kind") == "message.deleted",
            handler,
        )

    def on_unknown_event(
        self,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        def register(fn: Handler) -> Handler:
            self._unknown_handler = fn
            return fn

        if handler is not None:
            return register(handler)
        return register

    def on_slash_command(
        self,
        command_name: str | Handler | None = None,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        """Register a slash command handler.

        ``command_name`` may be given with or without a leading slash and is
        matched case-insensitively. Calling this with only a handler (either
        as the sole positional argument or via ``handler=``) registers a bare
        fallback that matches every slash command lacking a more specific
        named handler.
        """

        if callable(command_name):
            self._slash_command_handlers.append(
                _SlashCommandRegistration(command_name=None, handler=command_name)
            )
            return command_name

        normalized_name = (
            _normalize_slash_command_name(command_name)
            if isinstance(command_name, str)
            else None
        )

        def register(fn: Handler) -> Handler:
            self._slash_command_handlers.append(
                _SlashCommandRegistration(command_name=normalized_name, handler=fn)
            )
            return fn

        if handler is not None:
            return register(handler)
        return register

    def on(
        self,
        kind: str,
        handler: Handler | None = None,
    ) -> Handler | Callable[[Handler], Handler]:
        """Register a handler for any known Chat event ``kind`` string.

        Raises ``ValueError`` for unrecognized kinds so misspelled event
        names fail fast at registration time rather than silently never
        firing.
        """

        if not isinstance(kind, str) or kind not in KNOWN_EVENT_KINDS:
            raise ValueError(f"Unknown Google Chat event kind: {kind!r}")

        def register(fn: Handler) -> Handler:
            self._generic_handlers.setdefault(kind, []).append(fn)
            return fn

        if handler is not None:
            return register(handler)
        return register

    def dispatch(
        self,
        payload: Mapping[str, Any],
        *,
        source: str = "chat_http",
        received_at: str | None = None,
    ) -> dict[str, Any]:
        """Synchronously dispatch a local Chat event payload."""

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            coroutine = self._dispatch_async(
                payload,
                source=source,
                received_at=received_at,
                # Preserve the caller's thread for the ordinary synchronous
                # fixture/application path. Deadline dispatch needs off-loop
                # work so its budget remains meaningful.
                offload_sync_dedupe=self._deadline is not None,
            )
            if self._deadline is None:
                return asyncio.run(coroutine)
            return self._run_deadline_dispatch_sync(coroutine)

        raise RuntimeError(
            "GoogleChatAI.dispatch() cannot run inside an active event loop. "
            "Use dispatch_async()."
        )

    def _run_deadline_dispatch_sync(
        self,
        coroutine: Awaitable[dict[str, Any]],
    ) -> dict[str, Any]:
        """Run deadline dispatch on the shared late-work supervisor loop."""

        future = asyncio.run_coroutine_threadsafe(
            coroutine,
            _sync_deadline_supervisor_loop(),
        )
        return future.result()

    async def dispatch_async(
        self,
        payload: Mapping[str, Any],
        *,
        source: str = "chat_http",
        received_at: str | None = None,
    ) -> dict[str, Any]:
        """Asynchronously dispatch a local Chat event payload."""

        return await self._dispatch_async(
            payload,
            source=source,
            received_at=received_at,
            offload_sync_dedupe=True,
        )

    async def _dispatch_async(
        self,
        payload: Mapping[str, Any],
        *,
        source: str,
        received_at: str | None,
        offload_sync_dedupe: bool,
    ) -> dict[str, Any]:
        """Internal dispatch with an explicit sync-store execution policy."""

        raw_event = self._copy_mapping(payload)
        event = self._normalize_payload(raw_event, source=source, received_at=received_at)

        return await self._dispatch_with_deadline(
            event,
            raw_event,
            offload_sync_dedupe=offload_sync_dedupe,
        )

    async def _dispatch_with_deadline(
        self,
        event: dict[str, Any],
        raw_event: Mapping[str, Any],
        *,
        offload_sync_dedupe: bool,
    ) -> dict[str, Any]:
        """Race cooperative handler work against a deadline without blocking
        the caller's event loop.

        ``asyncio.wait`` leaves the handler task running when the timeout wins,
        so the caller can receive the Chat fallback while the underlying work
        finishes and is logged. This matches the Node runtime's non-cancelling
        ``Promise.race`` behavior without moving async handlers to a second
        event loop.
        """

        if self._deadline is None:
            return await self._dispatch_delivery(
                event,
                raw_event,
                offload_sync_dedupe=offload_sync_dedupe,
            )

        budget_ms = self._deadline.budget_ms
        task = asyncio.create_task(
            self._dispatch_delivery(
                event,
                raw_event,
                offload_sync_dedupe=offload_sync_dedupe,
            )
        )

        done, _ = await asyncio.wait({task}, timeout=budget_ms / 1000)
        if task in done:
            return task.result()

        self._logger.warning(
            "chat.event.deadline_exceeded",
            extra={
                "event_id": event.get("eventId"),
                "event_kind": event.get("kind"),
            },
        )

        def log_late_completion(completed: asyncio.Task[dict[str, Any]]) -> None:
            try:
                completed.result()
            except BaseException as exc:  # noqa: BLE001 - log detached task failure
                self._logger.error(
                    "chat.event.late_failure",
                    extra={
                        "event_id": event.get("eventId"),
                        "event_kind": event.get("kind"),
                        "error_message": str(exc),
                    },
                )
            else:
                self._logger.info(
                    "chat.event.late_result",
                    extra={
                        "event_id": event.get("eventId"),
                        "event_kind": event.get("kind"),
                    },
                )

        task.add_done_callback(log_late_completion)

        on_deadline = self._deadline.on_deadline
        if on_deadline is not None:
            context = HandlerContext(
                chat=self,
                event=event,
                raw_event=raw_event,
                context_loader=self._context_loader,
                reply_routing=self._reply_routing,
            )
            try:
                return normalize_handler_response(
                    await self._invoke_handler(on_deadline, context)
                )
            except _BlockingWorkSaturatedError:
                self._logger.error(
                    "chat.event.deadline_callback_capacity_exhausted",
                    extra={
                        "event_id": event.get("eventId"),
                        "event_kind": event.get("kind"),
                    },
                )

        return json_response(text="Still working on it...")

    async def _dispatch_delivery(
        self,
        event: dict[str, Any],
        raw_event: Mapping[str, Any],
        *,
        offload_sync_dedupe: bool,
    ) -> dict[str, Any]:
        """Run duplicate protection and the handler within the deadline task."""

        idempotency_key = event.get("idempotencyKey")
        if (
            self._dedupe is not None
            and isinstance(idempotency_key, str)
            and idempotency_key.strip() != ""
        ):
            store, ttl_ms, configured_offload = self._dedupe
            if self._deadline is not None or (
                offload_sync_dedupe and configured_offload
            ):
                guard = await _run_bounded_blocking(
                    guard_duplicate_event_delivery,
                    event,
                    store=store,
                    ttl_ms=ttl_ms,
                )
            else:
                guard = guard_duplicate_event_delivery(
                    event,
                    store=store,
                    ttl_ms=ttl_ms,
                )
            if guard["duplicate"]:
                self._logger.info(
                    "chat.event.duplicate",
                    extra={
                        "event_id": event.get("eventId"),
                        "event_kind": event.get("kind"),
                    },
                )
                return {"status": "duplicate_event_ignored"}

        return await self._dispatch_event(event, raw_event)

    async def _invoke_handler(
        self,
        handler: Handler,
        context: HandlerContext,
    ) -> HandlerResult:
        """Invoke handlers without letting sync code defeat a configured deadline."""

        if self._deadline is not None and not inspect.iscoroutinefunction(handler):
            result = await _run_bounded_blocking(handler, context)
        else:
            result = handler(context)
        if inspect.isawaitable(result):
            return await result
        return result

    async def _dispatch_event(
        self,
        event: dict[str, Any],
        raw_event: Mapping[str, Any],
    ) -> dict[str, Any]:
        handler = self._resolve_handler(event)

        self._logger.info(
            "googlechatai.router.dispatch",
            extra={
                "event_id": event.get("eventId"),
                "event_kind": event.get("kind"),
                "has_handler": handler is not None,
            },
        )

        if handler is None:
            return {}

        context = HandlerContext(
            chat=self,
            event=event,
            raw_event=raw_event,
            context_loader=self._context_loader,
            reply_routing=self._reply_routing,
        )

        try:
            return normalize_handler_response(await self._invoke_handler(handler, context))
        except _BlockingWorkSaturatedError:
            self._logger.error(
                "googlechatai.router.blocking_work_capacity_exhausted",
                extra={
                    "event_id": event.get("eventId"),
                    "event_kind": event.get("kind"),
                    "handler_name": getattr(handler, "__name__", repr(handler)),
                },
            )
            raise
        except Exception:
            self._logger.exception(
                "googlechatai.router.handler_error",
                extra={
                    "event_id": event.get("eventId"),
                    "event_kind": event.get("kind"),
                    "handler_name": getattr(handler, "__name__", repr(handler)),
                },
            )
            if self._raise_handler_errors:
                raise
            return dict(self._error_response)

    def _decorate(
        self,
        name: str,
        predicate: Predicate,
        handler: Handler | None,
    ) -> Handler | Callable[[Handler], Handler]:
        def register(fn: Handler) -> Handler:
            self._handlers.append(
                _HandlerRegistration(name=name, predicate=predicate, handler=fn)
            )
            return fn

        if handler is not None:
            return register(handler)
        return register

    def _resolve_handler(self, event: Mapping[str, Any]) -> Handler | None:
        """Resolve the single handler that should run for ``event``.

        Dispatch precedence mirrors the Node runtime exactly: a specific
        registration (named slash command, or one of the dedicated
        ``on_*`` methods) wins first, then any generic ``on(kind)``
        registration, then the family fallback (message.* kinds fall back
        to ``on_message``, mentions fall back to ``on_message`` when no
        ``on_mention`` handler is registered, and everything unmatched
        falls back to ``on_unknown_event``).
        """

        kind = event.get("kind")
        generic = self._generic_handlers.get(kind, [])

        if kind == "message.slash_command":
            command_name = _slash_command_name_for_event(event)
            named = _first(
                registration.handler
                for registration in self._slash_command_handlers
                if registration.command_name is not None
                and registration.command_name == command_name
            )
            if named is not None:
                return named
            bare = _first(
                registration.handler
                for registration in self._slash_command_handlers
                if registration.command_name is None
            )
            if bare is not None:
                return bare
            return (
                _first(generic)
                or _first(self._message_handlers)
                or self._unknown_handler
            )

        if kind == "message.mentioned_app":
            mention_handlers = self._mention_handlers or self._message_handlers
            return _first(mention_handlers) or _first(generic) or self._unknown_handler

        for registration in self._handlers:
            if registration.predicate(event):
                return registration.handler

        specific = _first(generic)
        if specific is not None:
            return specific

        if isinstance(kind, str) and kind.startswith("message."):
            fallback = _first(self._message_handlers)
            if fallback is not None:
                return fallback

        return self._unknown_handler

    def _normalize_payload(
        self,
        payload: Mapping[str, Any],
        *,
        source: str,
        received_at: str | None,
    ) -> dict[str, Any]:
        event = normalize_event(payload, source=source, received_at=received_at)
        return _adapt_event_for_router(event, payload, self._app_user)

    def _copy_mapping(self, value: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            raise TypeError("Expected a Google Chat event object.")
        return dict(value)


__all__ = [
    "ChatResponse",
    "DeliveryCapacityError",
    "GoogleChatAI",
    "HandlerContext",
    "json_response",
]
