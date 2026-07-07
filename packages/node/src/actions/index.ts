import type {
  ChatEventSource,
  ChatSpaceRef,
  ChatUserRef,
  FormInputValue,
  NormalizedAction,
  NormalizedActionType,
  ValidationError,
} from "../types.js";

type RawRecord = Record<string, unknown>;

export interface NormalizeActionOptions {
  source?: ChatEventSource;
}

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringLike(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeUser(value: unknown): ChatUserRef | null {
  const raw = asRecord(value);
  const name = asString(raw?.name);

  if (!raw || !name) {
    return null;
  }

  return {
    name,
    displayName: asString(raw.displayName),
    type: asString(raw.type),
  };
}

function normalizeSpace(value: unknown): ChatSpaceRef | null {
  const raw = asRecord(value);
  const name = asString(raw?.name);

  if (!raw || !name) {
    return null;
  }

  return {
    name,
    displayName: asString(raw.displayName),
    type: asString(raw.type),
  };
}

function resourceUser(name: string): ChatUserRef {
  return {
    name,
    displayName: null,
    type: null,
  };
}

function resourceSpace(name: string): ChatSpaceRef {
  return {
    name,
    displayName: null,
    type: null,
  };
}

function addError(
  validationErrors: ValidationError[],
  field: string | null,
  code: string,
  message: string,
): void {
  validationErrors.push({ field, code, message });
}

function inputSource(raw: RawRecord): RawRecord | null {
  return asRecord(raw.common) ?? asRecord(raw.commonEventObject);
}

function actionTypeFor(
  rawKind: string | null,
  raw: RawRecord,
  common: RawRecord | null,
  slashCommand: RawRecord | null,
): NormalizedActionType | null {
  const dialogEventType = asString(raw.dialogEventType) ?? asString(common?.dialogEventType);
  const commonParameters = asRecord(common?.parameters);

  if (dialogEventType === "SUBMIT_DIALOG" || rawKind === "SUBMIT_DIALOG") {
    return "dialog_submit";
  }

  if (
    dialogEventType === "CANCEL_DIALOG" ||
    dialogEventType === "CANCELLED_DIALOG" ||
    rawKind === "CANCEL_DIALOG"
  ) {
    return "dialog_cancel";
  }

  if (rawKind === "APP_COMMAND") {
    return "app_command";
  }

  if (rawKind === "MESSAGE" && slashCommand) {
    return "slash_command";
  }

  if (
    rawKind === "WIDGET_UPDATE" ||
    rawKind === "WIDGET_UPDATED" ||
    (rawKind === "CARD_CLICKED" && typeof commonParameters?.autocomplete_widget_query === "string")
  ) {
    return "widget_update";
  }

  if (rawKind === "CARD_CLICKED") {
    return "card_click";
  }

  return null;
}

function methodNameFor(
  actionType: NormalizedActionType,
  action: RawRecord | null,
  common: RawRecord | null,
  slashCommand: RawRecord | null,
  appCommandMetadata: RawRecord | null,
): string | null {
  return (
    asString(common?.invokedFunction) ??
    asString(action?.actionMethodName) ??
    asString(action?.function) ??
    asString(slashCommand?.commandName) ??
    asString(appCommandMetadata?.appCommandName) ??
    (actionType === "app_command" ? asStringLike(appCommandMetadata?.appCommandId) : null)
  );
}

function parseActionParameters(
  action: RawRecord | null,
  validationErrors: ValidationError[],
): Record<string, string> {
  const parameters: Record<string, string> = {};

  for (const item of asArray(action?.parameters)) {
    const parameter = asRecord(item);
    const key = asString(parameter?.key);
    const value = asString(parameter?.value);

    if (!parameter || !key) {
      addError(
        validationErrors,
        "parameters",
        "invalid_parameter",
        "Action parameter is missing a string key.",
      );
      continue;
    }

    if (value === null) {
      addError(
        validationErrors,
        `parameters.${key}`,
        "invalid_parameter",
        `Action parameter ${key} is missing a string value.`,
      );
      continue;
    }

    parameters[key] = value;
  }

  return parameters;
}

function parseCommonParameters(
  common: RawRecord | null,
  validationErrors: ValidationError[],
): Record<string, string> {
  const parameters: Record<string, string> = {};
  const rawParameters = asRecord(common?.parameters);

  if (!rawParameters) {
    return parameters;
  }

  for (const [key, value] of Object.entries(rawParameters)) {
    const normalizedValue = asString(value);
    if (normalizedValue === null) {
      addError(
        validationErrors,
        `parameters.${key}`,
        "invalid_parameter",
        `Action parameter ${key} is missing a string value.`,
      );
      continue;
    }

    parameters[key] = normalizedValue;
  }

  return parameters;
}

function parseSlashCommandParameters(
  slashCommand: RawRecord | null,
  message: RawRecord | null,
): Record<string, string> {
  if (!slashCommand) {
    return {};
  }

  const parameters: Record<string, string> = {};
  const commandId = asStringLike(slashCommand.commandId);
  const commandName = asString(slashCommand.commandName);
  const argumentText = asString(message?.argumentText);

  if (commandId !== null) {
    parameters.commandId = commandId;
  }

  if (commandName !== null) {
    parameters.commandName = commandName;
  }

  if (argumentText !== null) {
    parameters.argumentText = argumentText;
  }

  return parameters;
}

function parseAppCommandParameters(
  appCommandMetadata: RawRecord | null,
): Record<string, string> {
  if (!appCommandMetadata) {
    return {};
  }

  const parameters: Record<string, string> = {};
  const appCommandId = asStringLike(appCommandMetadata.appCommandId);
  const appCommandType = asString(appCommandMetadata.appCommandType);
  const appCommandName = asString(appCommandMetadata.appCommandName);

  if (appCommandId !== null) {
    parameters.appCommandId = appCommandId;
  }

  if (appCommandType !== null) {
    parameters.appCommandType = appCommandType;
  }

  if (appCommandName !== null) {
    parameters.appCommandName = appCommandName;
  }

  return parameters;
}

function parseBoolean(value: string): boolean | null {
  const lowered = value.toLowerCase();

  if (["true", "on", "checked", "1"].includes(lowered)) {
    return true;
  }

  if (["false", "off", "unchecked", "0"].includes(lowered)) {
    return false;
  }

  return null;
}

function parseStringInput(
  field: string,
  rawInput: RawRecord,
  validationErrors: ValidationError[],
): FormInputValue {
  const rawStringInput = asRecord(rawInput.stringInputs);
  const rawValues = rawStringInput?.value;

  if (!Array.isArray(rawValues) || !rawValues.every((value) => typeof value === "string")) {
    addError(
      validationErrors,
      field,
      "invalid_string_values",
      `String input ${field} must contain a string array.`,
    );
    return {
      kind: "string",
      value: null,
      values: [],
      raw: rawInput,
    };
  }

  const values = rawValues as string[];

  if (values.length > 0 && values.every((value) => value.startsWith("users/"))) {
    return {
      kind: "user_picker",
      value: values.map(resourceUser),
      values,
      raw: rawInput,
    };
  }

  if (values.length > 0 && values.every((value) => value.startsWith("spaces/"))) {
    return {
      kind: "space_picker",
      value: values.map(resourceSpace),
      values,
      raw: rawInput,
    };
  }

  if (values.length === 1) {
    const booleanValue = parseBoolean(values[0] ?? "");
    if (booleanValue !== null) {
      return {
        kind: "boolean",
        value: booleanValue,
        values,
        raw: rawInput,
      };
    }

    return {
      kind: "string",
      value: values[0] ?? null,
      values,
      raw: rawInput,
    };
  }

  return {
    kind: "multi_select",
    value: values,
    values,
    raw: rawInput,
  };
}

function epochValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return null;
}

function isValidEpoch(value: string | null): value is string {
  if (value === null || value.trim() === "") {
    return false;
  }

  return Number.isFinite(Number(value));
}

function parseDateInput(
  field: string,
  rawInput: RawRecord,
  validationErrors: ValidationError[],
): FormInputValue {
  const rawDateInput = asRecord(rawInput.dateInput);
  const msSinceEpoch = epochValue(rawDateInput?.msSinceEpoch);

  if (!isValidEpoch(msSinceEpoch)) {
    addError(
      validationErrors,
      field,
      "invalid_date",
      `Date input ${field} has invalid msSinceEpoch.`,
    );
    return {
      kind: "date",
      value: null,
      msSinceEpoch,
      raw: rawInput,
    };
  }

  return {
    kind: "date",
    value: new Date(Number(msSinceEpoch)).toISOString().slice(0, 10),
    msSinceEpoch,
    raw: rawInput,
  };
}

function parseDateTimeInput(
  field: string,
  rawInput: RawRecord,
  validationErrors: ValidationError[],
): FormInputValue {
  const rawDateTimeInput = asRecord(rawInput.dateTimeInput);
  const msSinceEpoch = epochValue(rawDateTimeInput?.msSinceEpoch);

  if (!isValidEpoch(msSinceEpoch)) {
    addError(
      validationErrors,
      field,
      "invalid_date_time",
      `Date-time input ${field} has invalid msSinceEpoch.`,
    );
    return {
      kind: "date_time",
      value: null,
      msSinceEpoch,
      raw: rawInput,
    };
  }

  return {
    kind: "date_time",
    value: new Date(Number(msSinceEpoch)).toISOString(),
    msSinceEpoch,
    raw: rawInput,
  };
}

function parseTimeInput(
  field: string,
  rawInput: RawRecord,
  validationErrors: ValidationError[],
): FormInputValue {
  const rawTimeInput = asRecord(rawInput.timeInput);
  const hours = rawTimeInput?.hours;
  const minutes = rawTimeInput?.minutes;

  if (
    typeof hours !== "number" ||
    typeof minutes !== "number" ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    addError(validationErrors, field, "invalid_time", `Time input ${field} is invalid.`);
    return {
      kind: "time",
      value: null,
      raw: rawInput,
    };
  }

  return {
    kind: "time",
    value: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    raw: rawInput,
  };
}

function parseFormInput(
  field: string,
  rawValue: unknown,
  validationErrors: ValidationError[],
): FormInputValue {
  const rawInput = asRecord(rawValue);

  if (!rawInput) {
    addError(
      validationErrors,
      field,
      "unsupported_form_input",
      `Form input ${field} has no supported Google Chat input value.`,
    );
    return {
      kind: "unknown",
      value: null,
      raw: rawValue,
    };
  }

  if (asRecord(rawInput.stringInputs)) {
    return parseStringInput(field, rawInput, validationErrors);
  }

  if (asRecord(rawInput.dateInput)) {
    return parseDateInput(field, rawInput, validationErrors);
  }

  if (asRecord(rawInput.timeInput)) {
    return parseTimeInput(field, rawInput, validationErrors);
  }

  if (asRecord(rawInput.dateTimeInput)) {
    return parseDateTimeInput(field, rawInput, validationErrors);
  }

  addError(
    validationErrors,
    field,
    "unsupported_form_input",
    `Form input ${field} has no supported Google Chat input value.`,
  );
  return {
    kind: "unknown",
    value: null,
    raw: rawInput,
  };
}

function parseFormInputs(
  common: RawRecord | null,
  validationErrors: ValidationError[],
): Record<string, FormInputValue> {
  const formInputs: Record<string, FormInputValue> = {};
  const rawFormInputs = asRecord(common?.formInputs);

  if (!rawFormInputs) {
    return formInputs;
  }

  for (const [field, rawInput] of Object.entries(rawFormInputs)) {
    formInputs[field] = parseFormInput(field, rawInput, validationErrors);
  }

  return formInputs;
}

function selectedUsersFrom(formInputs: Record<string, FormInputValue>): ChatUserRef[] {
  return Object.values(formInputs).flatMap((input) =>
    input.kind === "user_picker" ? input.value : [],
  );
}

function selectedSpacesFrom(formInputs: Record<string, FormInputValue>): ChatSpaceRef[] {
  return Object.values(formInputs).flatMap((input) =>
    input.kind === "space_picker" ? input.value : [],
  );
}

function actorLabel(actor: ChatUserRef | null): string {
  if (!actor) {
    return "Unknown actor";
  }

  if (actor.displayName) {
    return `${actor.displayName} (${actor.name})`;
  }

  return actor.name;
}

function actionVerb(actionType: NormalizedActionType): string {
  switch (actionType) {
    case "slash_command":
      return "ran slash command";
    case "app_command":
      return "ran app command";
    case "card_click":
      return "clicked card action";
    case "dialog_submit":
      return "submitted dialog action";
    case "dialog_cancel":
      return "cancelled dialog action";
    case "widget_update":
      return "updated widget action";
    case "link_preview":
      return "requested link preview action";
  }
}

function sortedParameterSummary(parameters: Record<string, string>): string | null {
  const entries = Object.entries(parameters).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  if (entries.length === 0) {
    return null;
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formInputNote(field: string, input: FormInputValue): string {
  switch (input.kind) {
    case "string":
      return input.value === null
        ? `System Note: Form field ${field} contains invalid string input.`
        : `System Note: Form field ${field} has value ${JSON.stringify(input.value)}.`;
    case "multi_select":
      return `System Note: Form field ${field} has values ${input.value.join(", ")}.`;
    case "boolean":
      return `System Note: Form field ${field} has value ${String(input.value)}.`;
    case "date":
      return input.value === null
        ? `System Note: Form field ${field} contains invalid date input.`
        : `System Note: Form field ${field} has date ${input.value}.`;
    case "time":
      return input.value === null
        ? `System Note: Form field ${field} contains invalid time input.`
        : `System Note: Form field ${field} has time ${input.value}.`;
    case "date_time":
      return input.value === null
        ? `System Note: Form field ${field} contains invalid date-time input.`
        : `System Note: Form field ${field} has date-time ${input.value}.`;
    case "user_picker":
      return `System Note: Form field ${field} selected ${input.value
        .map((user) => user.name)
        .join(", ")}.`;
    case "space_picker":
      return `System Note: Form field ${field} selected ${input.value
        .map((space) => space.name)
        .join(", ")}.`;
    case "unknown":
      return `System Note: Form field ${field} contains unsupported or unknown data.`;
  }
}

export function renderActionSystemNotes(action: Omit<NormalizedAction, "systemNotes">): string[] {
  const notes = [
    `System Note: ${actorLabel(action.actor)} ${actionVerb(action.actionType)} "${
      action.methodName ?? "unknown"
    }" at ${action.eventTime ?? "unknown time"}.`,
  ];

  const parameterSummary = sortedParameterSummary(action.parameters);
  if (parameterSummary) {
    notes.push(`System Note: Action parameters: ${parameterSummary}.`);
  }

  for (const [field, input] of Object.entries(action.formInputs).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    notes.push(formInputNote(field, input));
  }

  return notes;
}

function actionIdFor(
  source: ChatEventSource,
  actionType: NormalizedActionType,
  methodName: string | null,
  messageName: string | null,
  eventTime: string | null,
): string {
  return `${source}:${actionType}:${methodName ?? "unknown"}:${
    messageName ?? "no-message"
  }:${eventTime ?? "no-time"}`;
}

export function normalizeAction(
  input: unknown,
  options: NormalizeActionOptions = {},
): NormalizedAction | null {
  const raw = asRecord(input);

  if (!raw) {
    throw new TypeError("Expected a Google Chat event object.");
  }

  const rawKind = asString(raw.type);
  const action = asRecord(raw.action);
  const common = inputSource(raw);
  const message = asRecord(raw.message);
  const slashCommand = asRecord(message?.slashCommand);
  const appCommandMetadata = asRecord(raw.appCommandMetadata);
  const actionType = actionTypeFor(rawKind, raw, common, slashCommand);

  if (actionType === null) {
    return null;
  }

  const validationErrors: ValidationError[] = [];
  const methodName = methodNameFor(
    actionType,
    action,
    common,
    slashCommand,
    appCommandMetadata,
  );
  const parameters = {
    ...parseActionParameters(action, validationErrors),
    ...parseCommonParameters(common, validationErrors),
    ...parseSlashCommandParameters(slashCommand, message),
    ...parseAppCommandParameters(appCommandMetadata),
  };
  const formInputs = parseFormInputs(common, validationErrors);
  const eventTime = asString(raw.eventTime);
  const source = options.source ?? "chat_http";
  const normalizedWithoutNotes = {
    actionId: actionIdFor(
      source,
      actionType,
      methodName,
      asString(message?.name),
      eventTime,
    ),
    actionType,
    methodName,
    actor: normalizeUser(raw.user ?? message?.sender),
    eventTime,
    parameters,
    formInputs,
    selectedUsers: selectedUsersFrom(formInputs),
    selectedSpaces: selectedSpacesFrom(formInputs),
    validationErrors,
    raw: {
      action: action ?? null,
      common: common ?? null,
      slashCommand: slashCommand ?? null,
      appCommandMetadata: appCommandMetadata ?? null,
      dialogEventType: asString(raw.dialogEventType) ?? asString(common?.dialogEventType),
    },
  };

  return {
    ...normalizedWithoutNotes,
    systemNotes: renderActionSystemNotes(normalizedWithoutNotes),
  };
}
