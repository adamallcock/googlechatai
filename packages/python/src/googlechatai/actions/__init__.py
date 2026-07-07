"""Action and form normalization helpers for Google Chat event payloads."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any


RawMapping = Mapping[str, Any]


def _as_mapping(value: Any) -> RawMapping | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_string_like(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return str(value)
    return None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _normalize_user(value: Any) -> dict[str, Any] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    return {
        "name": name,
        "displayName": _as_string(raw.get("displayName")),
        "type": _as_string(raw.get("type")),
    }


def _resource_user(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "displayName": None,
        "type": None,
    }


def _resource_space(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "displayName": None,
        "type": None,
    }


def _add_error(
    validation_errors: list[dict[str, Any]],
    field: str | None,
    code: str,
    message: str,
) -> None:
    validation_errors.append(
        {
            "field": field,
            "code": code,
            "message": message,
        }
    )


def _input_source(raw: RawMapping) -> RawMapping | None:
    return _as_mapping(raw.get("common")) or _as_mapping(raw.get("commonEventObject"))


def _action_type_for(
    raw_kind: str | None,
    raw: RawMapping,
    common: RawMapping | None,
    slash_command: RawMapping | None,
) -> str | None:
    dialog_event_type = _as_string(raw.get("dialogEventType")) or (
        _as_string(common.get("dialogEventType")) if common else None
    )
    common_parameters = _as_mapping(common.get("parameters")) if common else None

    if dialog_event_type == "SUBMIT_DIALOG" or raw_kind == "SUBMIT_DIALOG":
        return "dialog_submit"

    if dialog_event_type in {"CANCEL_DIALOG", "CANCELLED_DIALOG"} or raw_kind == "CANCEL_DIALOG":
        return "dialog_cancel"

    if raw_kind == "APP_COMMAND":
        return "app_command"

    if raw_kind == "MESSAGE" and slash_command:
        return "slash_command"

    if raw_kind in {"WIDGET_UPDATE", "WIDGET_UPDATED"} or (
        raw_kind == "CARD_CLICKED"
        and common_parameters
        and isinstance(common_parameters.get("autocomplete_widget_query"), str)
    ):
        return "widget_update"

    if raw_kind == "CARD_CLICKED":
        return "card_click"

    return None


def _method_name_for(
    action_type: str,
    action: RawMapping | None,
    common: RawMapping | None,
    slash_command: RawMapping | None,
    app_command_metadata: RawMapping | None,
) -> str | None:
    return (
        (_as_string(common.get("invokedFunction")) if common else None)
        or (_as_string(action.get("actionMethodName")) if action else None)
        or (_as_string(action.get("function")) if action else None)
        or (_as_string(slash_command.get("commandName")) if slash_command else None)
        or (
            _as_string(app_command_metadata.get("appCommandName"))
            if app_command_metadata
            else None
        )
        or (
            _as_string_like(app_command_metadata.get("appCommandId"))
            if action_type == "app_command" and app_command_metadata
            else None
        )
    )


def _parse_action_parameters(
    action: RawMapping | None,
    validation_errors: list[dict[str, Any]],
) -> dict[str, str]:
    parameters: dict[str, str] = {}

    for item in _as_list(action.get("parameters") if action else None):
        parameter = _as_mapping(item)
        key = _as_string(parameter.get("key")) if parameter else None
        value = _as_string(parameter.get("value")) if parameter else None

        if not parameter or not key:
            _add_error(
                validation_errors,
                "parameters",
                "invalid_parameter",
                "Action parameter is missing a string key.",
            )
            continue

        if value is None:
            _add_error(
                validation_errors,
                f"parameters.{key}",
                "invalid_parameter",
                f"Action parameter {key} is missing a string value.",
            )
            continue

        parameters[key] = value

    return parameters


def _parse_common_parameters(
    common: RawMapping | None,
    validation_errors: list[dict[str, Any]],
) -> dict[str, str]:
    parameters: dict[str, str] = {}
    raw_parameters = _as_mapping(common.get("parameters")) if common else None

    if not raw_parameters:
        return parameters

    for key, value in raw_parameters.items():
        normalized_value = _as_string(value)
        if normalized_value is None:
            _add_error(
                validation_errors,
                f"parameters.{key}",
                "invalid_parameter",
                f"Action parameter {key} is missing a string value.",
            )
            continue

        parameters[key] = normalized_value

    return parameters


def _parse_slash_command_parameters(
    slash_command: RawMapping | None,
    message: RawMapping | None,
) -> dict[str, str]:
    if not slash_command:
        return {}

    parameters: dict[str, str] = {}
    command_id = _as_string_like(slash_command.get("commandId"))
    command_name = _as_string(slash_command.get("commandName"))
    argument_text = _as_string(message.get("argumentText")) if message else None

    if command_id is not None:
        parameters["commandId"] = command_id
    if command_name is not None:
        parameters["commandName"] = command_name
    if argument_text is not None:
        parameters["argumentText"] = argument_text

    return parameters


def _parse_app_command_parameters(
    app_command_metadata: RawMapping | None,
) -> dict[str, str]:
    if not app_command_metadata:
        return {}

    parameters: dict[str, str] = {}
    app_command_id = _as_string_like(app_command_metadata.get("appCommandId"))
    app_command_type = _as_string(app_command_metadata.get("appCommandType"))
    app_command_name = _as_string(app_command_metadata.get("appCommandName"))

    if app_command_id is not None:
        parameters["appCommandId"] = app_command_id
    if app_command_type is not None:
        parameters["appCommandType"] = app_command_type
    if app_command_name is not None:
        parameters["appCommandName"] = app_command_name

    return parameters


def _parse_boolean(value: str) -> bool | None:
    lowered = value.lower()
    if lowered in {"true", "on", "checked", "1"}:
        return True
    if lowered in {"false", "off", "unchecked", "0"}:
        return False
    return None


def _parse_string_input(
    field: str,
    raw_input: RawMapping,
    validation_errors: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_string_input = _as_mapping(raw_input.get("stringInputs"))
    raw_values = raw_string_input.get("value") if raw_string_input else None

    if not isinstance(raw_values, list) or not all(
        isinstance(value, str) for value in raw_values
    ):
        _add_error(
            validation_errors,
            field,
            "invalid_string_values",
            f"String input {field} must contain a string array.",
        )
        return {
            "kind": "string",
            "value": None,
            "values": [],
            "raw": dict(raw_input),
        }

    values = raw_values

    if values and all(value.startswith("users/") for value in values):
        return {
            "kind": "user_picker",
            "value": [_resource_user(value) for value in values],
            "values": values,
            "raw": dict(raw_input),
        }

    if values and all(value.startswith("spaces/") for value in values):
        return {
            "kind": "space_picker",
            "value": [_resource_space(value) for value in values],
            "values": values,
            "raw": dict(raw_input),
        }

    if len(values) == 1:
        boolean_value = _parse_boolean(values[0])
        if boolean_value is not None:
            return {
                "kind": "boolean",
                "value": boolean_value,
                "values": values,
                "raw": dict(raw_input),
            }

        return {
            "kind": "string",
            "value": values[0],
            "values": values,
            "raw": dict(raw_input),
        }

    return {
        "kind": "multi_select",
        "value": values,
        "values": values,
        "raw": dict(raw_input),
    }


def _epoch_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, int | float) and not isinstance(value, bool):
        return str(value)
    return None


def _is_valid_epoch(value: str | None) -> bool:
    if value is None or not value.strip():
        return False
    try:
        float(value)
    except ValueError:
        return False
    return True


def _parse_date_input(
    field: str,
    raw_input: RawMapping,
    validation_errors: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_date_input = _as_mapping(raw_input.get("dateInput"))
    ms_since_epoch = _epoch_value(raw_date_input.get("msSinceEpoch")) if raw_date_input else None

    if not _is_valid_epoch(ms_since_epoch):
        _add_error(
            validation_errors,
            field,
            "invalid_date",
            f"Date input {field} has invalid msSinceEpoch.",
        )
        return {
            "kind": "date",
            "value": None,
            "msSinceEpoch": ms_since_epoch,
            "raw": dict(raw_input),
        }

    assert ms_since_epoch is not None
    value = datetime.fromtimestamp(float(ms_since_epoch) / 1000, UTC).date().isoformat()
    return {
        "kind": "date",
        "value": value,
        "msSinceEpoch": ms_since_epoch,
        "raw": dict(raw_input),
    }


def _parse_date_time_input(
    field: str,
    raw_input: RawMapping,
    validation_errors: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_date_time_input = _as_mapping(raw_input.get("dateTimeInput"))
    ms_since_epoch = (
        _epoch_value(raw_date_time_input.get("msSinceEpoch"))
        if raw_date_time_input
        else None
    )

    if not _is_valid_epoch(ms_since_epoch):
        _add_error(
            validation_errors,
            field,
            "invalid_date_time",
            f"Date-time input {field} has invalid msSinceEpoch.",
        )
        return {
            "kind": "date_time",
            "value": None,
            "msSinceEpoch": ms_since_epoch,
            "raw": dict(raw_input),
        }

    assert ms_since_epoch is not None
    value = (
        datetime.fromtimestamp(float(ms_since_epoch) / 1000, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    return {
        "kind": "date_time",
        "value": value,
        "msSinceEpoch": ms_since_epoch,
        "raw": dict(raw_input),
    }


def _parse_time_input(
    field: str,
    raw_input: RawMapping,
    validation_errors: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_time_input = _as_mapping(raw_input.get("timeInput"))
    hours = raw_time_input.get("hours") if raw_time_input else None
    minutes = raw_time_input.get("minutes") if raw_time_input else None

    if (
        not isinstance(hours, int)
        or not isinstance(minutes, int)
        or hours < 0
        or hours > 23
        or minutes < 0
        or minutes > 59
    ):
        _add_error(
            validation_errors,
            field,
            "invalid_time",
            f"Time input {field} is invalid.",
        )
        return {
            "kind": "time",
            "value": None,
            "raw": dict(raw_input),
        }

    return {
        "kind": "time",
        "value": f"{hours:02d}:{minutes:02d}",
        "raw": dict(raw_input),
    }


def _parse_form_input(
    field: str,
    raw_value: Any,
    validation_errors: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_input = _as_mapping(raw_value)

    if not raw_input:
        _add_error(
            validation_errors,
            field,
            "unsupported_form_input",
            f"Form input {field} has no supported Google Chat input value.",
        )
        return {
            "kind": "unknown",
            "value": None,
            "raw": raw_value,
        }

    if _as_mapping(raw_input.get("stringInputs")):
        return _parse_string_input(field, raw_input, validation_errors)
    if _as_mapping(raw_input.get("dateInput")):
        return _parse_date_input(field, raw_input, validation_errors)
    if _as_mapping(raw_input.get("timeInput")):
        return _parse_time_input(field, raw_input, validation_errors)
    if _as_mapping(raw_input.get("dateTimeInput")):
        return _parse_date_time_input(field, raw_input, validation_errors)

    _add_error(
        validation_errors,
        field,
        "unsupported_form_input",
        f"Form input {field} has no supported Google Chat input value.",
    )
    return {
        "kind": "unknown",
        "value": None,
        "raw": dict(raw_input),
    }


def _parse_form_inputs(
    common: RawMapping | None,
    validation_errors: list[dict[str, Any]],
) -> dict[str, Any]:
    form_inputs: dict[str, Any] = {}
    raw_form_inputs = _as_mapping(common.get("formInputs")) if common else None

    if not raw_form_inputs:
        return form_inputs

    for field, raw_input in raw_form_inputs.items():
        form_inputs[field] = _parse_form_input(field, raw_input, validation_errors)

    return form_inputs


def _selected_users_from(form_inputs: dict[str, Any]) -> list[dict[str, Any]]:
    users: list[dict[str, Any]] = []
    for input_value in form_inputs.values():
        if input_value["kind"] == "user_picker":
            users.extend(input_value["value"])
    return users


def _selected_spaces_from(form_inputs: dict[str, Any]) -> list[dict[str, Any]]:
    spaces: list[dict[str, Any]] = []
    for input_value in form_inputs.values():
        if input_value["kind"] == "space_picker":
            spaces.extend(input_value["value"])
    return spaces


def _actor_label(actor: dict[str, Any] | None) -> str:
    if not actor:
        return "Unknown actor"
    if actor["displayName"]:
        return f"{actor['displayName']} ({actor['name']})"
    return actor["name"]


def _action_verb(action_type: str) -> str:
    return {
        "slash_command": "ran slash command",
        "app_command": "ran app command",
        "card_click": "clicked card action",
        "dialog_submit": "submitted dialog action",
        "dialog_cancel": "cancelled dialog action",
        "widget_update": "updated widget action",
        "link_preview": "requested link preview action",
    }[action_type]


def _parameter_summary(parameters: dict[str, str]) -> str | None:
    if not parameters:
        return None
    return ", ".join(f"{key}={parameters[key]}" for key in sorted(parameters))


def _form_input_note(field: str, input_value: dict[str, Any]) -> str:
    kind = input_value["kind"]

    if kind == "string":
        if input_value["value"] is None:
            return f"System Note: Form field {field} contains invalid string input."
        return f"System Note: Form field {field} has value {json_quote(input_value['value'])}."

    if kind == "multi_select":
        return f"System Note: Form field {field} has values {', '.join(input_value['value'])}."

    if kind == "boolean":
        return (
            f"System Note: Form field {field} has value "
            f"{str(input_value['value']).lower()}."
        )

    if kind == "date":
        if input_value["value"] is None:
            return f"System Note: Form field {field} contains invalid date input."
        return f"System Note: Form field {field} has date {input_value['value']}."

    if kind == "time":
        if input_value["value"] is None:
            return f"System Note: Form field {field} contains invalid time input."
        return f"System Note: Form field {field} has time {input_value['value']}."

    if kind == "date_time":
        if input_value["value"] is None:
            return f"System Note: Form field {field} contains invalid date-time input."
        return f"System Note: Form field {field} has date-time {input_value['value']}."

    if kind == "user_picker":
        selected = ", ".join(user["name"] for user in input_value["value"])
        return f"System Note: Form field {field} selected {selected}."

    if kind == "space_picker":
        selected = ", ".join(space["name"] for space in input_value["value"])
        return f"System Note: Form field {field} selected {selected}."

    return f"System Note: Form field {field} contains unsupported or unknown data."


def json_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def render_action_system_notes(action: RawMapping) -> list[str]:
    notes = [
        (
            f"System Note: {_actor_label(action['actor'])} "
            f"{_action_verb(action['actionType'])} "
            f"\"{action['methodName'] or 'unknown'}\" at "
            f"{action['eventTime'] or 'unknown time'}."
        )
    ]

    parameter_summary = _parameter_summary(action["parameters"])
    if parameter_summary:
        notes.append(f"System Note: Action parameters: {parameter_summary}.")

    for field in sorted(action["formInputs"]):
        notes.append(_form_input_note(field, action["formInputs"][field]))

    return notes


def _action_id_for(
    source: str,
    action_type: str,
    method_name: str | None,
    message_name: str | None,
    event_time: str | None,
) -> str:
    return (
        f"{source}:{action_type}:{method_name or 'unknown'}:"
        f"{message_name or 'no-message'}:{event_time or 'no-time'}"
    )


def normalize_action(
    input_event: RawMapping,
    *,
    source: str = "chat_http",
) -> dict[str, Any] | None:
    """Normalize a Google Chat action-bearing event into one action object."""

    if not isinstance(input_event, Mapping):
        raise TypeError("Expected a Google Chat event object.")

    raw_kind = _as_string(input_event.get("type"))
    action = _as_mapping(input_event.get("action"))
    common = _input_source(input_event)
    message = _as_mapping(input_event.get("message"))
    slash_command = _as_mapping(message.get("slashCommand")) if message else None
    app_command_metadata = _as_mapping(input_event.get("appCommandMetadata"))
    action_type = _action_type_for(raw_kind, input_event, common, slash_command)

    if action_type is None:
        return None

    validation_errors: list[dict[str, Any]] = []
    method_name = _method_name_for(
        action_type,
        action,
        common,
        slash_command,
        app_command_metadata,
    )
    parameters = {
        **_parse_action_parameters(action, validation_errors),
        **_parse_common_parameters(common, validation_errors),
        **_parse_slash_command_parameters(slash_command, message),
        **_parse_app_command_parameters(app_command_metadata),
    }
    form_inputs = _parse_form_inputs(common, validation_errors)
    event_time = _as_string(input_event.get("eventTime"))
    normalized: dict[str, Any] = {
        "actionId": _action_id_for(
            source,
            action_type,
            method_name,
            _as_string(message.get("name")) if message else None,
            event_time,
        ),
        "actionType": action_type,
        "methodName": method_name,
        "actor": _normalize_user(input_event.get("user") or (message or {}).get("sender")),
        "eventTime": event_time,
        "parameters": parameters,
        "formInputs": form_inputs,
        "selectedUsers": _selected_users_from(form_inputs),
        "selectedSpaces": _selected_spaces_from(form_inputs),
        "validationErrors": validation_errors,
        "raw": {
            "action": dict(action) if action else None,
            "common": dict(common) if common else None,
            "slashCommand": dict(slash_command) if slash_command else None,
            "appCommandMetadata": dict(app_command_metadata)
            if app_command_metadata
            else None,
            "dialogEventType": _as_string(input_event.get("dialogEventType"))
            or (_as_string(common.get("dialogEventType")) if common else None),
        },
    }
    normalized["systemNotes"] = render_action_system_notes(normalized)
    return normalized
