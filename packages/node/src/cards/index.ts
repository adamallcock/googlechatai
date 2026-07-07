type JsonRecord = Record<string, unknown>;

export interface CardActionConfig {
  function: string;
  parameters?: Record<string, string | number | boolean | null | undefined>;
}

export const DEFAULT_CARD_ACTION_STATE_PARAMETER = "__googleChatAiState";

export interface CardMessageOptions {
  cardId?: string;
  title?: string;
  subtitle?: string;
  fallbackText?: string;
  card?: Record<string, unknown>;
  sections?: CardSectionOptions[];
  widgets?: unknown[];
}

export interface CardFieldOption {
  label?: string;
  text?: string;
}

export interface CardButtonOption {
  text: string;
  action?: CardActionConfig;
  openLink?: string;
}

export interface CardSectionOptions {
  header?: string;
  text?: string | string[];
  fields?: CardFieldOption[];
  widgets?: unknown[];
  buttons?: CardButtonOption[];
  collapsible?: boolean;
  uncollapsibleWidgetsCount?: number;
}

export interface ApprovalCardOptions {
  cardId?: string;
  title: string;
  subtitle?: string;
  body: string;
  approveLabel?: string;
  rejectLabel?: string;
  approveAction: CardActionConfig;
  rejectAction: CardActionConfig;
}

export interface ProgressCardStep {
  label: string;
  status: "complete" | "active" | "pending" | string;
}

export interface ProgressCardOptions {
  cardId?: string;
  title: string;
  subtitle?: string;
  detail?: string;
  percent?: number;
  steps?: ProgressCardStep[];
  cancelAction?: CardActionConfig;
}

export interface ErrorCardOptions {
  cardId?: string;
  title: string;
  message: string;
  details?: string;
  retryAction?: CardActionConfig;
}

export interface FeedbackCardOptions {
  cardId?: string;
  title?: string;
  subtitle?: string;
  responseId?: string;
  helpfulLabel?: string;
  notHelpfulLabel?: string;
  commentLabel?: string;
  upAction: CardActionConfig;
  downAction: CardActionConfig;
  commentAction?: CardActionConfig;
}

export interface FeedbackAccessoryOptions {
  text?: string;
  fallbackText?: string;
  responseId?: string;
  upAction: CardActionConfig;
  downAction: CardActionConfig;
  commentAction?: CardActionConfig;
  helpfulAltText?: string;
  notHelpfulAltText?: string;
  commentAltText?: string;
  buttonType?: string;
  iconFill?: boolean;
}

export interface SourceCardSource {
  title: string;
  url?: string;
  resourceName?: string;
  label?: string;
  confidence?: string;
  snippet?: string;
}

export interface SourcesCardOptions {
  cardId?: string;
  title?: string;
  subtitle?: string;
  responseId?: string;
  sources?: SourceCardSource[];
}

export interface ThinkingCardOptions {
  cardId?: string;
  title?: string;
  status?: string;
  detail?: string;
  startedAt?: string;
}

export interface ToolStatusItem {
  name: string;
  status: string;
  detail?: string;
  output?: string;
}

export interface ToolStatusCardOptions {
  cardId?: string;
  title?: string;
  tools?: ToolStatusItem[];
}

export interface StreamingStatusCardOptions {
  cardId?: string;
  title?: string;
  mode?: string;
  status?: string;
  patchCount?: number;
  throttleMs?: number;
  finalAction?: CardActionConfig;
}

export interface DialogFieldOption {
  name: string;
  label: string;
  type: "text" | "selection" | "switch" | string;
  value?: string;
  multiline?: boolean;
  selectionType?: string;
  selected?: boolean;
  items?: Array<{ text: string; value: string; selected?: boolean }>;
  rawWidget?: unknown;
}

export interface DialogOptions {
  title: string;
  submitLabel?: string;
  submitAction: CardActionConfig;
  fields?: DialogFieldOption[];
}

export type CardNavigationKind = "push" | "update";

export interface CardNavigationStep {
  type: CardNavigationKind;
  card: DialogOptions | JsonRecord;
}

export interface BuiltCardMessage {
  fallbackText: string;
  text: string;
  cardsV2: unknown[];
}

export interface BuiltAccessoryMessage {
  fallbackText: string;
  text: string;
  accessoryWidgets: unknown[];
}

export type ChatMessageResponseInput =
  | string
  | JsonRecord
  | BuiltCardMessage
  | BuiltAccessoryMessage;

export interface CardValidationResult {
  ok: boolean;
  errors: string[];
}

export type CardLintSurface =
  | "chat-message"
  | "direct-chat-response"
  | "chat-dialog-response"
  | "workspace-addon-action-response"
  | "dialogflow-custom-payload";

export interface CardLintOptions {
  surface?: CardLintSurface | string;
  principal?: "app" | "user" | string | null;
  allowNamedFunctions?: boolean;
  allowDeveloperPreviewUserCards?: boolean;
}

export interface CardTranslationOptions {
  from?: CardLintSurface | string;
  to?: CardLintSurface | string;
  mode?: "create-message" | "update-message" | "open-dialog" | string;
}

export interface CardLintFinding {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
  remediation: string;
}

export interface CardLintStats {
  cards: number;
  sections: number;
  widgets: number;
  buttons: number;
  images: number;
  bytes: number;
}

export interface CardLintResult {
  kind: "chat.card_lint_result";
  surface: string;
  ok: boolean;
  summary: string;
  stats: CardLintStats;
  findings: CardLintFinding[];
  translated: null;
}

export interface CardTranslationResult {
  kind: "chat.card_translation_result";
  from: string;
  to: string;
  mode: string;
  ok: boolean;
  findings: CardLintFinding[];
  payload: JsonRecord | null;
}

export interface CardActionSummary {
  actionType: "card_click" | "dialog_submit" | "dialog_cancel" | "widget_update";
  methodName: string | null;
  parameters: Record<string, string>;
  formInputs: Record<string, FormInputSummary>;
  actor: {
    name: string;
    displayName: string | null;
    type: string | null;
  } | null;
  eventTime: string | null;
}

export interface FormInputSummary {
  kind: string;
  values: string[];
  value: string | null;
}

export type CardActionRouteHandler<Result> = (
  summary: CardActionSummary,
) => Result;

export interface CardActionRouteHandlers<Result> {
  methods?: Record<string, CardActionRouteHandler<Result>>;
  cardClick?: CardActionRouteHandler<Result>;
  dialogSubmit?: CardActionRouteHandler<Result>;
  dialogCancel?: CardActionRouteHandler<Result>;
  widgetUpdate?: CardActionRouteHandler<Result>;
  unknown?: CardActionRouteHandler<Result>;
}

export interface CardActionRouteResult<Result> {
  matched: boolean;
  route: string | null;
  summary: CardActionSummary;
  result: Result | undefined;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function requiredString(raw: JsonRecord | null, key: string, fallback = ""): string {
  return asString(raw?.[key]) ?? fallback;
}

function cleanRecord(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  );
}

function sortedParameters(
  parameters: unknown,
): Array<{ key: string; value: string }> {
  const raw = asRecord(parameters);

  if (!raw) {
    return [];
  }

  return Object.entries(raw)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value: String(value) }));
}

function parametersObjectFromArray(parameters: unknown): Record<string, string> {
  const pairs = asArray(parameters)
    .map((item) => {
      const raw = asRecord(item);
      const key = asString(raw?.key);
      const value = asString(raw?.value);
      return key && value !== null ? [key, value] : null;
    })
    .filter((item): item is [string, string] => item !== null);

  return sortObject(Object.fromEntries(pairs));
}

function sortObject(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function actionButton(text: string, action: unknown): JsonRecord {
  const raw = asRecord(action);
  const functionName = requiredString(raw, "function");

  return {
    text,
    onClick: {
      action: {
        function: functionName,
        parameters: sortedParameters(raw?.parameters),
      },
    },
  };
}

function iconActionButton(
  iconName: string,
  altText: string,
  action: unknown,
  options: { buttonType: string; iconFill: boolean },
): JsonRecord {
  const raw = asRecord(action);
  const functionName = requiredString(raw, "function");

  return {
    icon: {
      materialIcon: {
        name: iconName,
        fill: options.iconFill,
      },
    },
    altText,
    type: options.buttonType,
    onClick: {
      action: {
        function: functionName,
        parameters: sortedParameters(raw?.parameters),
      },
    },
  };
}

function linkButton(text: string, url: string): JsonRecord {
  return {
    text,
    onClick: {
      openLink: {
        url,
      },
    },
  };
}

function buttonFromOption(button: unknown): JsonRecord | null {
  const raw = asRecord(button);
  const text = requiredString(raw, "text");
  const openLink = asString(raw?.openLink);

  if (!raw || !text) {
    return null;
  }

  if (openLink) {
    return linkButton(text, openLink);
  }

  return actionButton(text, raw.action);
}

function messageWithSingleCard(
  fallbackText: string,
  cardId: string,
  card: JsonRecord,
): BuiltCardMessage {
  return {
    fallbackText,
    text: fallbackText,
    cardsV2: [
      {
        cardId,
        card,
      },
    ],
  };
}

function sectionTextItems(value: unknown): string[] {
  const direct = asString(value);

  if (direct !== null) {
    return [direct];
  }

  return asArray(value).filter((item): item is string => typeof item === "string");
}

function sectionFromOption(section: unknown): JsonRecord {
  const raw = asRecord(section);
  const widgets: unknown[] = [];

  for (const text of sectionTextItems(raw?.text)) {
    widgets.push({
      textParagraph: {
        text,
      },
    });
  }

  for (const field of asArray(raw?.fields)) {
    const rawField = asRecord(field);
    widgets.push({
      decoratedText: cleanRecord({
        topLabel: asString(rawField?.label),
        text: asString(rawField?.text),
      }),
    });
  }

  widgets.push(...asArray(raw?.widgets));

  const buttons = asArray(raw?.buttons)
    .map(buttonFromOption)
    .filter((button): button is JsonRecord => button !== null);

  if (buttons.length > 0) {
    widgets.push({
      buttonList: {
        buttons,
      },
    });
  }

  return cleanRecord({
    header: asString(raw?.header),
    collapsible: typeof raw?.collapsible === "boolean" ? raw.collapsible : undefined,
    uncollapsibleWidgetsCount:
      typeof raw?.uncollapsibleWidgetsCount === "number"
        ? raw.uncollapsibleWidgetsCount
        : undefined,
    widgets,
  });
}

export function buildCardMessage(options: CardMessageOptions): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title");
  const subtitle = asString(raw?.subtitle);
  const cardId = requiredString(raw, "cardId", "card");
  const fallbackText =
    requiredString(raw, "fallbackText") || `${title || cardId} card.`;
  const rawCard = asRecord(raw?.card);

  if (rawCard) {
    return messageWithSingleCard(fallbackText, cardId, rawCard);
  }

  const sections =
    asArray(raw?.sections).length > 0
      ? asArray(raw?.sections).map(sectionFromOption)
      : [sectionFromOption({ widgets: asArray(raw?.widgets) })];

  return messageWithSingleCard(fallbackText, cardId, {
    header: cleanRecord({
      title,
      subtitle,
    }),
    sections,
  });
}

export function buildApprovalCard(options: ApprovalCardOptions): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title");
  const subtitle = asString(raw?.subtitle);
  const body = requiredString(raw, "body");
  const approveLabel = requiredString(raw, "approveLabel", "Approve");
  const rejectLabel = requiredString(raw, "rejectLabel", "Reject");
  const cardId = requiredString(raw, "cardId", "approval");
  const buttons = [
    actionButton(approveLabel, raw?.approveAction),
    actionButton(rejectLabel, raw?.rejectAction),
  ];
  const fallbackText =
    `Approval requested: ${title} ${body} Actions: ${approveLabel}, ${rejectLabel}.`;

  return messageWithSingleCard(fallbackText, cardId, {
    header: cleanRecord({
      title,
      subtitle,
    }),
    sections: [
      {
        widgets: [
          {
            textParagraph: {
              text: body,
            },
          },
          {
            buttonList: {
              buttons,
            },
          },
        ],
      },
    ],
  });
}

function stepStatusLabel(status: string): string {
  if (status === "complete") {
    return "Completed";
  }

  if (status === "active") {
    return "In progress";
  }

  return "Pending";
}

function stepWidgetLabel(status: string): string {
  return status.toUpperCase();
}

export function buildProgressCard(options: ProgressCardOptions): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title");
  const subtitle = asString(raw?.subtitle);
  const detail = asString(raw?.detail);
  const cardId = requiredString(raw, "cardId", "progress");
  const percent = typeof raw?.percent === "number" ? raw.percent : null;
  const steps = asArray(raw?.steps)
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null);
  const fallbackParts = [`Progress: ${title}.`];

  if (percent !== null) {
    fallbackParts.push(`${percent}% complete.`);
  }

  for (const step of steps) {
    fallbackParts.push(
      `${stepStatusLabel(requiredString(step, "status", "pending"))}: ${requiredString(
        step,
        "label",
      )}.`,
    );
  }

  const widgets: JsonRecord[] = [];

  if (detail) {
    widgets.push({ textParagraph: { text: detail } });
  }

  if (percent !== null) {
    widgets.push({
      decoratedText: {
        topLabel: "PROGRESS",
        text: `${percent}% complete`,
      },
    });
  }

  for (const step of steps) {
    const status = requiredString(step, "status", "pending");
    widgets.push({
      decoratedText: {
        topLabel: stepWidgetLabel(status),
        text: requiredString(step, "label"),
      },
    });
  }

  const cancelAction = raw?.cancelAction;
  if (asRecord(cancelAction)) {
    widgets.push({
      buttonList: {
        buttons: [actionButton("Cancel", cancelAction)],
      },
    });
  }

  return messageWithSingleCard(fallbackParts.join(" "), cardId, {
    header: cleanRecord({
      title,
      subtitle,
    }),
    sections: [
      {
        widgets,
      },
    ],
  });
}

export function buildErrorCard(options: ErrorCardOptions): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title");
  const message = requiredString(raw, "message");
  const details = asString(raw?.details);
  const cardId = requiredString(raw, "cardId", "error");
  const widgets: JsonRecord[] = [
    {
      textParagraph: {
        text: message,
      },
    },
  ];
  const fallbackParts = [`Error: ${title}.`, message];

  if (details) {
    fallbackParts.push(`Details: ${details}`);
    widgets.push({
      decoratedText: {
        topLabel: "DETAILS",
        text: details,
      },
    });
  }

  if (asRecord(raw?.retryAction)) {
    fallbackParts.push("Action: Retry.");
    widgets.push({
      buttonList: {
        buttons: [actionButton("Retry", raw?.retryAction)],
      },
    });
  }

  return messageWithSingleCard(fallbackParts.join(" "), cardId, {
    header: {
      title,
      subtitle: "Error",
    },
    sections: [
      {
        widgets,
      },
    ],
  });
}

export function buildFeedbackCard(options: FeedbackCardOptions): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title", "Was this helpful?");
  const subtitle = asString(raw?.subtitle) ?? "Feedback";
  const cardId = requiredString(raw, "cardId", "feedback");
  const responseId = asString(raw?.responseId);
  const helpfulLabel = requiredString(raw, "helpfulLabel", "Helpful");
  const notHelpfulLabel = requiredString(raw, "notHelpfulLabel", "Not helpful");
  const commentLabel = requiredString(raw, "commentLabel", "Add comment");
  const buttons = [
    actionButton(helpfulLabel, raw?.upAction),
    actionButton(notHelpfulLabel, raw?.downAction),
  ];
  const actions = [helpfulLabel, notHelpfulLabel];

  if (asRecord(raw?.commentAction)) {
    buttons.push(actionButton(commentLabel, raw?.commentAction));
    actions.push(commentLabel);
  }

  const subject = responseId ? `response ${responseId}` : "this response";
  return messageWithSingleCard(
    `Feedback requested for ${subject}. Actions: ${actions.join(", ")}.`,
    cardId,
    {
      header: cleanRecord({ title, subtitle }),
      sections: [
        {
          widgets: [
            {
              buttonList: {
                buttons,
              },
            },
          ],
        },
      ],
    },
  );
}

export function buildFeedbackAccessoryWidgets(
  options: FeedbackAccessoryOptions,
): JsonRecord[] {
  const raw = asRecord(options);
  const buttonType = requiredString(raw, "buttonType", "BORDERLESS");
  const iconFill = raw?.iconFill === false ? false : true;
  const buttons = [
    iconActionButton(
      "thumb_up",
      requiredString(raw, "helpfulAltText", "Mark helpful"),
      raw?.upAction,
      { buttonType, iconFill },
    ),
    iconActionButton(
      "thumb_down",
      requiredString(raw, "notHelpfulAltText", "Mark not helpful"),
      raw?.downAction,
      { buttonType, iconFill },
    ),
  ];

  if (asRecord(raw?.commentAction)) {
    buttons.push(
      iconActionButton(
        "rate_review",
        requiredString(raw, "commentAltText", "Add feedback comment"),
        raw?.commentAction,
        { buttonType, iconFill },
      ),
    );
  }

  return [
    {
      buttonList: {
        buttons,
      },
    },
  ];
}

export function buildFeedbackAccessoryMessage(
  options: FeedbackAccessoryOptions,
): BuiltAccessoryMessage {
  const raw = asRecord(options);
  const text = requiredString(raw, "text");

  return {
    fallbackText: asString(raw?.fallbackText) ?? text,
    text,
    accessoryWidgets: buildFeedbackAccessoryWidgets(options),
  };
}

function sourceTopLabel(source: JsonRecord): string | undefined {
  const parts = [
    asString(source.label),
    asString(source.confidence)
      ? `${asString(source.confidence)} confidence`
      : null,
  ].filter((item): item is string => item !== null && item.length > 0);
  return parts.length ? parts.join(" - ") : undefined;
}

function sourceWidget(source: JsonRecord): JsonRecord {
  const url = asString(source.url);
  return {
    decoratedText: cleanRecord({
      topLabel: sourceTopLabel(source),
      text: requiredString(source, "title", "Untitled source"),
      bottomLabel: asString(source.snippet) ?? asString(source.resourceName),
      button: url ? linkButton("Open", url) : undefined,
    }),
  };
}

export function buildSourcesCard(options: SourcesCardOptions): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title", "Sources");
  const cardId = requiredString(raw, "cardId", "sources");
  const responseId = asString(raw?.responseId);
  const sources = asArray(raw?.sources)
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null);
  const names = sources.map((source) =>
    requiredString(source, "title", "Untitled source"),
  );
  const subject = responseId ? `response ${responseId}` : "response";

  return messageWithSingleCard(
    `Sources for ${subject}: ${names.join(", ")}.`,
    cardId,
    {
      header: {
        title,
        subtitle: `${sources.length} source${sources.length === 1 ? "" : "s"}`,
      },
      sections: [
        {
          widgets: sources.map(sourceWidget),
        },
      ],
    },
  );
}

export function buildThinkingCard(options: ThinkingCardOptions): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title", "Thinking");
  const cardId = requiredString(raw, "cardId", "thinking");
  const status = requiredString(raw, "status", "thinking");
  const detail = asString(raw?.detail);
  const startedAt = asString(raw?.startedAt);
  const fallbackParts = [`Thinking: ${title}.`];
  const widgets: JsonRecord[] = [
    {
      decoratedText: {
        topLabel: "STATUS",
        text: status,
      },
    },
  ];

  if (detail) {
    fallbackParts.push(detail);
    widgets.push({ textParagraph: { text: detail } });
  }
  if (startedAt) {
    fallbackParts.push(`Started at ${startedAt}.`);
    widgets.push({
      decoratedText: {
        topLabel: "STARTED",
        text: startedAt,
      },
    });
  }

  return messageWithSingleCard(fallbackParts.join(" "), cardId, {
    header: { title, subtitle: "Thinking" },
    sections: [{ widgets }],
  });
}

export function buildToolStatusCard(
  options: ToolStatusCardOptions,
): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title", "Tool calls");
  const cardId = requiredString(raw, "cardId", "tool-status");
  const tools = asArray(raw?.tools)
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null);
  const fallback = tools
    .map((tool) => `${requiredString(tool, "name")} ${requiredString(tool, "status")}.`)
    .join(" ");

  return messageWithSingleCard(`Tool status: ${fallback}`, cardId, {
    header: { title, subtitle: `${tools.length} tool call${tools.length === 1 ? "" : "s"}` },
    sections: [
      {
        widgets: tools.map((tool) => {
          const status = requiredString(tool, "status", "unknown");
          return {
            decoratedText: cleanRecord({
              topLabel: status.toUpperCase(),
              text: requiredString(tool, "name", "unknown_tool"),
              bottomLabel: asString(tool.output) ?? asString(tool.detail),
            }),
          };
        }),
      },
    ],
  });
}

export function buildStreamingStatusCard(
  options: StreamingStatusCardOptions,
): BuiltCardMessage {
  const raw = asRecord(options);
  const title = requiredString(raw, "title", "Streaming response");
  const cardId = requiredString(raw, "cardId", "streaming-status");
  const mode = requiredString(raw, "mode", "create_then_patch");
  const status = requiredString(raw, "status", "streaming");
  const patchCount = asNumber(raw?.patchCount) ?? 0;
  const throttleMs = asNumber(raw?.throttleMs);
  const widgets: JsonRecord[] = [
    { decoratedText: { topLabel: "MODE", text: mode } },
    { decoratedText: { topLabel: "STATUS", text: status } },
    { decoratedText: { topLabel: "PATCHES", text: `${patchCount}` } },
  ];
  const fallbackParts = [
    `Streaming response: ${mode} mode, ${status}, ${patchCount} patch(es)`,
  ];

  if (throttleMs !== null) {
    fallbackParts.push(`throttle ${throttleMs}ms`);
    widgets.push({
      decoratedText: { topLabel: "THROTTLE", text: `${throttleMs}ms` },
    });
  }
  if (asRecord(raw?.finalAction)) {
    widgets.push({
      buttonList: {
        buttons: [actionButton("Cancel", raw?.finalAction)],
      },
    });
  }

  return messageWithSingleCard(`${fallbackParts.join(", ")}.`, cardId, {
    header: { title, subtitle: "Streaming" },
    sections: [{ widgets }],
  });
}

function dialogFieldToWidget(field: JsonRecord): JsonRecord {
  const type = requiredString(field, "type");
  const name = requiredString(field, "name");
  const label = requiredString(field, "label");

  if (type === "text") {
    return {
      textInput: cleanRecord({
        name,
        label,
        type: field.multiline === true ? "MULTIPLE_LINE" : "SINGLE_LINE",
        value: asString(field.value),
      }),
    };
  }

  if (type === "selection") {
    return {
      selectionInput: {
        name,
        label,
        type: requiredString(field, "selectionType", "DROPDOWN"),
        items: asArray(field.items).map((item) => {
          const raw = asRecord(item);
          return cleanRecord({
            text: requiredString(raw, "text"),
            value: requiredString(raw, "value"),
            selected: raw?.selected === true ? true : undefined,
          });
        }),
      },
    };
  }

  if (type === "switch") {
    return {
      decoratedText: {
        text: label,
        switchControl: {
          name,
          selected: asBoolean(field.selected),
          controlType: "SWITCH",
        },
      },
    };
  }

  return cleanRecord({
    rawWidget: field.rawWidget,
  });
}

export function buildDialog(options: DialogOptions): JsonRecord {
  const raw = asRecord(options);
  const title = requiredString(raw, "title");
  const submitLabel = requiredString(raw, "submitLabel", "Submit");
  const fields = asArray(raw?.fields)
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null);
  const fieldLabels = fields.map((field) => requiredString(field, "label"));
  const widgets = fields.map(dialogFieldToWidget);

  widgets.push({
    buttonList: {
      buttons: [actionButton(submitLabel, raw?.submitAction)],
    },
  });

  return {
    fallbackText: `Dialog requested: ${title}. Fields: ${fieldLabels.join(", ")}.`,
    actionResponse: {
      type: "DIALOG",
      dialogAction: {
        dialog: {
          body: {
            sections: [
              {
                widgets,
              },
            ],
          },
        },
      },
    },
  };
}

function messageResponseBody(input: ChatMessageResponseInput): JsonRecord {
  if (typeof input === "string") {
    return { text: input };
  }

  return asRecord(input) ?? {};
}

function dialogCardFromOptions(input: DialogOptions | JsonRecord): JsonRecord {
  const raw = asRecord(input);

  if (!raw) {
    return { sections: [] };
  }

  if (asRecord(raw.header) || Array.isArray(raw.sections)) {
    return raw;
  }

  const title = requiredString(raw, "title");
  const submitLabel = requiredString(raw, "submitLabel", "Submit");
  const fields = asArray(raw.fields)
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null);
  const widgets = fields.map(dialogFieldToWidget);

  widgets.push({
    buttonList: {
      buttons: [actionButton(submitLabel, raw.submitAction)],
    },
  });

  return {
    header: cleanRecord({
      title,
    }),
    sections: [
      {
        widgets,
      },
    ],
  };
}

export function buildUpdateCardResponse(
  message: ChatMessageResponseInput,
): JsonRecord {
  return {
    hostAppDataAction: {
      chatDataAction: {
        updateMessageAction: {
          message: messageResponseBody(message),
        },
      },
    },
  };
}

export function buildCreateMessageResponse(
  message: ChatMessageResponseInput,
): JsonRecord {
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: messageResponseBody(message),
        },
      },
    },
  };
}

export function buildOpenDialogResponse(
  dialog: DialogOptions | JsonRecord,
): JsonRecord {
  return buildCardNavigationResponse(pushCard(dialog));
}

export function pushCard(card: DialogOptions | JsonRecord): CardNavigationStep {
  return {
    type: "push",
    card,
  };
}

export function updateCard(card: DialogOptions | JsonRecord): CardNavigationStep {
  return {
    type: "update",
    card,
  };
}

function navigationFromStep(step: CardNavigationStep): JsonRecord {
  const card = dialogCardFromOptions(step.card);

  if (step.type === "update") {
    return {
      updateCard: card,
    };
  }

  return {
    pushCard: card,
  };
}

export function buildCardNavigationResponse(
  steps: CardNavigationStep | CardNavigationStep[],
): JsonRecord {
  const navigations = (Array.isArray(steps) ? steps : [steps]).map(navigationFromStep);

  return {
    action: {
      navigations,
    },
  };
}

function emptyLintStats(input: unknown): CardLintStats {
  return {
    cards: 0,
    sections: 0,
    widgets: 0,
    buttons: 0,
    images: 0,
    bytes: compactJsonBytes(input),
  };
}

function lintFinding(
  severity: CardLintFinding["severity"],
  code: string,
  pathLabel: string,
  message: string,
  remediation: string,
): CardLintFinding {
  return { severity, code, path: pathLabel, message, remediation };
}

function isUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function lintSummary(findings: CardLintFinding[]): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  return `${plural(errors, "error")}, ${plural(warnings, "warning")}`;
}

function buttonHasClick(button: JsonRecord | null): boolean {
  const onClick = asRecord(button?.onClick);
  const action = asRecord(onClick?.action);
  const openLink = asRecord(onClick?.openLink);
  return Boolean(asString(action?.function)?.trim() || asString(openLink?.url)?.trim());
}

function visitButtonsForLint(
  buttons: unknown[],
  pathLabel: string,
  surface: string,
  options: CardLintOptions,
  findings: CardLintFinding[],
): void {
  buttons.forEach((button, buttonIndex) => {
    const buttonPath = `${pathLabel}.buttons[${buttonIndex}]`;
    const buttonRecord = asRecord(button);

    if (!buttonHasClick(buttonRecord)) {
      findings.push(
        lintFinding(
          "error",
          "button_missing_onclick",
          buttonPath,
          "Button must define onClick.action.function or onClick.openLink.url.",
          "Add an action function or openLink URL to the button.",
        ),
      );
    }

    if (asRecord(buttonRecord?.icon) && !asString(buttonRecord?.altText)?.trim()) {
      findings.push(
        lintFinding(
          "warning",
          "button_missing_alt_text",
          `${buttonPath}.altText`,
          "Icon buttons should include altText for accessibility.",
          "Add concise altText that describes the button action.",
        ),
      );
    }

    const actionFunction = asString(
      asRecord(asRecord(buttonRecord?.onClick)?.action)?.function,
    );
    if (
      surface === "workspace-addon-action-response" &&
      actionFunction &&
      !isUrlLike(actionFunction) &&
      options.allowNamedFunctions !== true
    ) {
      findings.push(
        lintFinding(
          "error",
          "addon_action_function_not_url",
          `${buttonPath}.onClick.action.function`,
          "Workspace add-on card actions must use a full HTTP URL as action.function.",
          "Use the deployed card-action endpoint URL as the function and pass the logical action name in parameters.",
        ),
      );
    }
  });
}

function visitWidgetsForLint(
  widgets: unknown[],
  pathLabel: string,
  surface: string,
  options: CardLintOptions,
  stats: CardLintStats,
  findings: CardLintFinding[],
): void {
  stats.widgets += widgets.length;

  widgets.forEach((widget, widgetIndex) => {
    const widgetPath = `${pathLabel}[${widgetIndex}]`;
    const widgetRecord = asRecord(widget);
    const buttonList = asRecord(widgetRecord?.buttonList);
    const buttons = asArray(buttonList?.buttons);

    if (buttonList) {
      stats.buttons += buttons.length;
      visitButtonsForLint(
        buttons,
        `${widgetPath}.buttonList`,
        surface,
        options,
        findings,
      );
    }

    const image = asRecord(widgetRecord?.image);
    if (image) {
      stats.images += 1;
      if (!asString(image.altText)?.trim()) {
        findings.push(
          lintFinding(
            "warning",
            "image_missing_alt_text",
            `${widgetPath}.image.altText`,
            "Image widgets should include altText for accessibility.",
            "Add altText that describes the image content or purpose.",
          ),
        );
      }
    }
  });
}

function visitCardForLint(
  card: unknown,
  pathLabel: string,
  surface: string,
  options: CardLintOptions,
  stats: CardLintStats,
  findings: CardLintFinding[],
  { requireTitle = true }: { requireTitle?: boolean } = {},
): void {
  const cardRecord = asRecord(card);
  const header = asRecord(cardRecord?.header);

  if (requireTitle && !asString(header?.title)?.trim()) {
    findings.push(
      lintFinding(
        "error",
        "card_header_title_required",
        `${pathLabel}.header.title`,
        `${pathLabel}.header.title is required`,
        "Add a concise card header title.",
      ),
    );
  }

  if (asString(header?.imageUrl)?.trim() && !asString(header?.imageAltText)?.trim()) {
    findings.push(
      lintFinding(
        "warning",
        "header_image_missing_alt_text",
        `${pathLabel}.header.imageAltText`,
        "Card header images should include imageAltText for accessibility.",
        "Add imageAltText that describes the header image.",
      ),
    );
  }

  const sections = asArray(cardRecord?.sections);
  stats.sections += sections.length;
  let widgetCountForCard = 0;
  let warnedWidgetLimit = false;

  sections.forEach((section, sectionIndex) => {
    const sectionPath = `${pathLabel}.sections[${sectionIndex}]`;
    const sectionRecord = asRecord(section);
    const widgets = asArray(sectionRecord?.widgets);

    if (!Array.isArray(sectionRecord?.widgets)) {
      findings.push(
        lintFinding(
          "error",
          "section_widgets_required",
          `${sectionPath}.widgets`,
          "Card sections must define a widgets array.",
          "Add widgets: [] or remove the empty section.",
        ),
      );
      return;
    }

    if (!warnedWidgetLimit && widgetCountForCard + widgets.length > 100) {
      warnedWidgetLimit = true;
      findings.push(
        lintFinding(
          "warning",
          "card_widget_limit_exceeded",
          sectionPath,
          "This section pushes the card over Google Chat's 100-widget limit and can be ignored with following sections.",
          "Split the content across multiple cards or messages before this section.",
        ),
      );
    }

    widgetCountForCard += widgets.length;
    visitWidgetsForLint(widgets, `${sectionPath}.widgets`, surface, options, stats, findings);
  });
}

function visitMessageBodyForLint(
  message: JsonRecord,
  pathLabel: string,
  surface: string,
  options: CardLintOptions,
  stats: CardLintStats,
  findings: CardLintFinding[],
): void {
  const cards = asArray(message.cardsV2);
  const accessoryWidgets = asArray(message.accessoryWidgets);

  if (
    surface === "chat-message" &&
    accessoryWidgets.length > 0 &&
    (Array.isArray(message.attachment) || Array.isArray(message.attachments))
  ) {
    findings.push(
      lintFinding(
        "error",
        "accessory_attachment_conflict",
        `${pathLabel}.accessoryWidgets`,
        "Accessory widgets are not supported on messages that contain attachments.",
        "Send the attachment and accessory controls as separate messages.",
      ),
    );
  }

  if (
    accessoryWidgets.length > 0 &&
    asString(asRecord(message.actionResponse)?.type) === "DIALOG"
  ) {
    findings.push(
      lintFinding(
        "error",
        "accessory_dialog_conflict",
        `${pathLabel}.accessoryWidgets`,
        "Accessory widgets are not supported for messages that contain dialogs.",
        "Return the dialog response without accessoryWidgets.",
      ),
    );
  }

  if (
    surface === "chat-message" &&
    options.principal === "user" &&
    options.allowDeveloperPreviewUserCards !== true &&
    (cards.length > 0 || accessoryWidgets.length > 0)
  ) {
    findings.push(
      lintFinding(
        "warning",
        "user_auth_card_preview_required",
        pathLabel,
        "User-auth card and accessory-widget sends require Developer Preview support.",
        "Use app auth for rich Chat messages unless the tenant and app are in the Developer Preview path.",
      ),
    );
  }

  if (cards.length > 0 && surface === "chat-message") {
    if (!asString(message.fallbackText)?.trim()) {
      findings.push(
        lintFinding(
          "error",
          "fallback_text_required",
          `${pathLabel}.fallbackText`,
          "fallbackText is required",
          "Add a plain-text description of the card for notifications and clients that can't render cards.",
        ),
      );
    }
    if (!asString(message.text)?.trim()) {
      findings.push(
        lintFinding(
          "error",
          "text_fallback_required",
          `${pathLabel}.text`,
          "text fallback is required",
          "Add a short text fallback alongside the card payload.",
        ),
      );
    }
  }

  cards.forEach((entry, cardIndex) => {
    stats.cards += 1;
    visitCardForLint(
      asRecord(entry)?.card,
      `${pathLabel}.cardsV2[${cardIndex}].card`,
      surface,
      options,
      stats,
      findings,
    );
  });

  visitWidgetsForLint(
    accessoryWidgets,
    `${pathLabel}.accessoryWidgets`,
    surface,
    options,
    stats,
    findings,
  );
}

function chatDataActionForLint(raw: JsonRecord): JsonRecord | null {
  return asRecord(asRecord(raw.hostAppDataAction)?.chatDataAction);
}

function lintWorkspaceAddonResponse(
  raw: JsonRecord,
  surface: string,
  options: CardLintOptions,
  stats: CardLintStats,
  findings: CardLintFinding[],
): void {
  const chatData = chatDataActionForLint(raw);
  const action = asRecord(raw.action);
  const navigations = asArray(action?.navigations);
  const messageActions = [
    ["createMessageAction", asRecord(asRecord(chatData?.createMessageAction)?.message)],
    ["updateMessageAction", asRecord(asRecord(chatData?.updateMessageAction)?.message)],
    ["updateInlinePreviewAction", asRecord(chatData?.updateInlinePreviewAction)],
  ] as const;
  const presentActionCount =
    messageActions.filter(([, message]) => message !== null).length +
    (navigations.length > 0 ? 1 : 0);

  if (presentActionCount === 0) {
    findings.push(
      lintFinding(
        "error",
        "addon_action_missing",
        "$",
        "Workspace add-on responses must include hostAppDataAction.chatDataAction or action.navigations.",
        "Wrap message updates in createMessageAction/updateMessageAction or card navigation in action.navigations.",
      ),
    );
  }

  if (presentActionCount > 1) {
    findings.push(
      lintFinding(
        "warning",
        "addon_multiple_primary_actions",
        "$",
        "Workspace add-on response contains multiple primary action paths.",
        "Return one create/update/navigation action per response unless Google explicitly documents the combination.",
      ),
    );
  }

  for (const [actionName, message] of messageActions) {
    if (message) {
      visitMessageBodyForLint(
        message,
        `$.hostAppDataAction.chatDataAction.${actionName}.message`,
        surface,
        options,
        stats,
        findings,
      );
    }
  }

  navigations.forEach((navigation, navigationIndex) => {
    const navigationRecord = asRecord(navigation);
    for (const key of ["pushCard", "updateCard"] as const) {
      const card = asRecord(navigationRecord?.[key]);
      if (card) {
        stats.cards += 1;
        visitCardForLint(
          card,
          `$.action.navigations[${navigationIndex}].${key}`,
          surface,
          options,
          stats,
          findings,
          { requireTitle: false },
        );
      }
    }
  });
}

export function lintCardPayload(
  payload: unknown,
  options: CardLintOptions = {},
): CardLintResult {
  const surface = options.surface ?? "chat-message";
  const stats = emptyLintStats(payload);
  const findings: CardLintFinding[] = [];
  const raw = asRecord(payload);

  if (!raw) {
    findings.push(
      lintFinding(
        "error",
        "payload_not_object",
        "$",
        "Card payload must be a JSON object.",
        "Pass the object that will be sent to Google Chat for this surface.",
      ),
    );
    return {
      kind: "chat.card_lint_result",
      surface,
      ok: false,
      summary: lintSummary(findings),
      stats,
      findings,
      translated: null,
    };
  }

  if (stats.bytes > 32_000) {
    findings.push(
      lintFinding(
        "warning",
        "payload_size_exceeds_chat_limit",
        "$",
        "Message and card JSON exceeds Google Chat's 32 KB message/card size guidance.",
        "Split the content into smaller messages or cards.",
      ),
    );
  } else if (stats.bytes > 28_000) {
    findings.push(
      lintFinding(
        "warning",
        "payload_size_near_chat_limit",
        "$",
        "Message and card JSON is close to Google Chat's 32 KB message/card size guidance.",
        "Consider shortening card content before adding more widgets.",
      ),
    );
  }

  if (surface !== "workspace-addon-action-response") {
    if (Array.isArray(raw.cards_v2)) {
      findings.push(
        lintFinding(
          "error",
          "wrong_cards_field",
          "$.cards_v2",
          "Use cardsV2 for Google Chat REST messages.",
          "Rename cards_v2 to cardsV2 for this profile.",
        ),
      );
    }
    if (Array.isArray(raw.cards)) {
      findings.push(
        lintFinding(
          "error",
          "deprecated_cards_field",
          "$.cards",
          "cards is deprecated for Google Chat messages.",
          "Use cardsV2 with CardWithId entries.",
        ),
      );
    }
  }

  if (surface === "chat-message") {
    if (asRecord(raw.hostAppDataAction)) {
      findings.push(
        lintFinding(
          "error",
          "addon_envelope_on_chat_message",
          "$.hostAppDataAction",
          "Workspace add-on action envelopes cannot be used as raw Chat message bodies.",
          "Pass only the message object to spaces.messages.create, or lint this payload with the workspace-addon-action-response profile.",
        ),
      );
    }
    if (asArray(asRecord(raw.action)?.navigations).length > 0) {
      findings.push(
        lintFinding(
          "error",
          "addon_envelope_on_chat_message",
          "$.action.navigations",
          "Workspace add-on navigation envelopes cannot be used as raw Chat message bodies.",
          "Return this payload from an add-on card action handler instead of sending it to spaces.messages.create.",
        ),
      );
    }
  }

  if (surface === "workspace-addon-action-response") {
    if (Array.isArray(raw.cardsV2) || asString(raw.text) || asRecord(raw.actionResponse)) {
      findings.push(
        lintFinding(
          "error",
          "addon_action_envelope_required",
          "$",
          "Workspace add-on responses must wrap Chat messages in an action envelope.",
          "Use hostAppDataAction.chatDataAction.createMessageAction/updateMessageAction or action.navigations.",
        ),
      );
    }
    lintWorkspaceAddonResponse(raw, surface, options, stats, findings);
  } else {
    visitMessageBodyForLint(raw, "$", surface, options, stats, findings);
  }

  return {
    kind: "chat.card_lint_result",
    surface,
    ok: findings.every((finding) => finding.severity !== "error"),
    summary: lintSummary(findings),
    stats,
    findings,
    translated: null,
  };
}

function messageBodyWithoutActionResponse(payload: JsonRecord): JsonRecord {
  const { actionResponse, ...message } = payload;
  return message;
}

function directChatMode(payload: JsonRecord, requestedMode: string | undefined): string {
  if (requestedMode) {
    return requestedMode;
  }

  const actionType = asString(asRecord(payload.actionResponse)?.type);
  if (actionType === "UPDATE_MESSAGE") {
    return "update-message";
  }
  if (actionType === "DIALOG") {
    return "open-dialog";
  }
  return "create-message";
}

function unsupportedTranslation(
  from: string,
  to: string,
  mode: string,
): CardTranslationResult {
  return {
    kind: "chat.card_translation_result",
    from,
    to,
    mode,
    ok: false,
    findings: [
      lintFinding(
        "error",
        "unsupported_card_translation",
        "$",
        `Unsupported card translation from ${from} to ${to} in ${mode} mode.`,
        "Use direct-chat-response to workspace-addon-action-response for create-message, update-message, or open-dialog in this SDK slice.",
      ),
    ],
    payload: null,
  };
}

export function translateCardPayload(
  payload: unknown,
  options: CardTranslationOptions = {},
): CardTranslationResult {
  const from = options.from ?? "direct-chat-response";
  const to = options.to ?? "workspace-addon-action-response";
  const raw = asRecord(payload);
  const mode = directChatMode(raw ?? {}, options.mode);

  if (!raw) {
    return unsupportedTranslation(from, to, mode);
  }

  if (from === "direct-chat-response" && to === "workspace-addon-action-response") {
    if (mode === "update-message") {
      return {
        kind: "chat.card_translation_result",
        from,
        to,
        mode,
        ok: true,
        findings: [],
        payload: {
          hostAppDataAction: {
            chatDataAction: {
              updateMessageAction: {
                message: messageBodyWithoutActionResponse(raw),
              },
            },
          },
        },
      };
    }

    if (mode === "create-message") {
      return {
        kind: "chat.card_translation_result",
        from,
        to,
        mode,
        ok: true,
        findings: [],
        payload: {
          hostAppDataAction: {
            chatDataAction: {
              createMessageAction: {
                message: messageBodyWithoutActionResponse(raw),
              },
            },
          },
        },
      };
    }

    if (mode === "open-dialog") {
      const dialog = asRecord(asRecord(asRecord(raw.actionResponse)?.dialogAction)?.dialog);
      return {
        kind: "chat.card_translation_result",
        from,
        to,
        mode,
        ok: true,
        findings: [],
        payload: {
          action: {
            navigations: [
              {
                pushCard: asRecord(dialog?.body) ?? {},
              },
            ],
          },
        },
      };
    }
  }

  if (from === "chat-message" && to === "direct-chat-response") {
    return {
      kind: "chat.card_translation_result",
      from,
      to,
      mode,
      ok: true,
      findings: [],
      payload: raw,
    };
  }

  return unsupportedTranslation(from, to, mode);
}

export function validateCardMessage(input: unknown): CardValidationResult {
  const raw = asRecord(input);

  if (!raw) {
    return { ok: false, errors: ["card message must be an object"] };
  }

  const result = lintCardPayload(input, { surface: "chat-message" });
  const errors = result.findings
    .filter((finding) => finding.severity === "error")
    .filter((finding) =>
      [
        "fallback_text_required",
        "text_fallback_required",
        "card_header_title_required",
        "button_missing_onclick",
      ].includes(finding.code),
    )
    .map((finding) => {
      if (finding.code === "button_missing_onclick") {
        return `${finding.path.replace(/^\$\./, "")}.onClick.action.function or onClick.openLink.url is required`;
      }
      if (finding.code === "card_header_title_required") {
        return finding.message.replace(/^\$\./, "");
      }
      return finding.message;
    });

  if (asArray(raw.cardsV2).length === 0) {
    errors.push("cardsV2 must include at least one card");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function summarizeButton(button: unknown): JsonRecord | null {
  const raw = asRecord(button);
  const onClick = asRecord(raw?.onClick);
  const action = asRecord(onClick?.action);
  const openLink = asRecord(onClick?.openLink);
  const text = asString(raw?.text);
  const functionName = asString(action?.function);
  const openLinkUrl = asString(openLink?.url);

  if (!text && !functionName && !openLinkUrl) {
    return null;
  }

  return cleanRecord({
    text,
    function: functionName,
    openLink: openLinkUrl,
    parameters: parametersObjectFromArray(action?.parameters),
  });
}

function summarizeImageWidget(image: unknown): JsonRecord | null {
  const raw = asRecord(image);

  if (!raw) {
    return null;
  }

  const openLink = asRecord(asRecord(raw.onClick)?.openLink);
  const action = asRecord(asRecord(raw.onClick)?.action);

  return cleanRecord({
    altText: asString(raw.altText),
    imageUrl: asString(raw.imageUrl),
    openLink: asString(openLink?.url),
    function: asString(action?.function),
    parameters: action ? parametersObjectFromArray(action.parameters) : undefined,
  });
}

function summarizeGrid(grid: unknown): JsonRecord | null {
  const raw = asRecord(grid);

  if (!raw) {
    return null;
  }

  const action = asRecord(asRecord(raw.onClick)?.action);
  const items = asArray(raw.items)
    .map((item) => {
      const itemRecord = asRecord(item);
      const image = asRecord(itemRecord?.image);
      return cleanRecord({
        id: asString(itemRecord?.id),
        title: asString(itemRecord?.title),
        subtitle: asString(itemRecord?.subtitle),
        imageAltText: asString(image?.altText),
      });
    })
    .filter((item) => Object.keys(item).length > 0);

  return cleanRecord({
    title: asString(raw.title),
    columnCount: typeof raw.columnCount === "number" ? raw.columnCount : undefined,
    items,
    function: asString(action?.function),
    parameters: action ? parametersObjectFromArray(action.parameters) : undefined,
  });
}

function summarizeColumns(columns: unknown): JsonRecord | null {
  const raw = asRecord(columns);

  if (!raw) {
    return null;
  }

  const columnItems = asArray(raw.columnItems ?? raw.columns)
    .map((column) => asRecord(column))
    .filter((column): column is JsonRecord => column !== null);

  return {
    columnCount: columnItems.length,
    columns: columnItems.map((column) => summarizeSection({ widgets: column.widgets })),
  };
}

function summarizeCarousel(carousel: unknown): JsonRecord | null {
  const raw = asRecord(carousel);

  if (!raw) {
    return null;
  }

  const cards = asArray(raw.carouselCards)
    .map((card) => asRecord(card))
    .filter((card): card is JsonRecord => card !== null)
    .map((card) =>
      cleanRecord({
        widgets: summarizeSection({ widgets: card.widgets }),
        footer: summarizeSection({ widgets: card.footerWidgets }),
      }),
    );

  return cleanRecord({
    cardCount: cards.length,
    cards,
  });
}

function summarizeChip(chip: unknown): JsonRecord | null {
  const raw = asRecord(chip);

  if (!raw) {
    return null;
  }

  const onClick = asRecord(raw.onClick);
  const action = asRecord(onClick?.action);
  const openLink = asRecord(onClick?.openLink);

  return cleanRecord({
    text: asString(raw.text) ?? asString(raw.label),
    disabled: raw.disabled === true ? true : undefined,
    function: asString(action?.function),
    openLink: asString(openLink?.url),
    parameters: action ? parametersObjectFromArray(action.parameters) : undefined,
  });
}

function summarizeDateTimePicker(picker: unknown): JsonRecord | null {
  const raw = asRecord(picker);

  if (!raw) {
    return null;
  }

  const value = raw.valueMsEpoch;

  return cleanRecord({
    name: asString(raw.name),
    label: asString(raw.label),
    type: asString(raw.type),
    valueMsEpoch:
      typeof value === "string" || typeof value === "number" ? String(value) : undefined,
  });
}

function selectedSelectionItems(selectionInput: JsonRecord): string[] {
  return asArray(selectionInput.items)
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null && item.selected === true)
    .map((item) => asString(item.text) ?? asString(item.value))
    .filter((item): item is string => item !== null);
}

function summarizeSection(section: unknown): JsonRecord {
  const raw = asRecord(section);
  const widgets = asArray(raw?.widgets);
  const text: string[] = [];
  const fields: JsonRecord[] = [];
  const buttons: JsonRecord[] = [];
  const images: JsonRecord[] = [];
  const grids: JsonRecord[] = [];
  const columns: JsonRecord[] = [];
  const carousels: JsonRecord[] = [];
  const chips: JsonRecord[] = [];
  const dateTimePickers: JsonRecord[] = [];
  let dividers = 0;

  for (const widget of widgets) {
    const widgetRecord = asRecord(widget);
    const textParagraph = asRecord(widgetRecord?.textParagraph);
    const image = asRecord(widgetRecord?.image);
    const decoratedText = asRecord(widgetRecord?.decoratedText);
    const textInput = asRecord(widgetRecord?.textInput);
    const selectionInput = asRecord(widgetRecord?.selectionInput);
    const dateTimePicker = asRecord(widgetRecord?.dateTimePicker);
    const buttonList = asRecord(widgetRecord?.buttonList);
    const divider = asRecord(widgetRecord?.divider);
    const grid = asRecord(widgetRecord?.grid);
    const columnSet = asRecord(widgetRecord?.columns);
    const carousel = asRecord(widgetRecord?.carousel);
    const chipList = asRecord(widgetRecord?.chipList);

    const paragraphText = asString(textParagraph?.text);
    if (paragraphText) {
      text.push(paragraphText);
    }

    const imageSummary = summarizeImageWidget(image);
    if (imageSummary) {
      images.push(imageSummary);
    }

    if (decoratedText) {
      fields.push(
        cleanRecord({
          label: asString(decoratedText.topLabel),
          text: asString(decoratedText.text),
        }),
      );
    }

    if (textInput) {
      fields.push(
        cleanRecord({
          name: asString(textInput.name),
          label: asString(textInput.label),
          type: asString(textInput.type),
        }),
      );
    }

    if (selectionInput) {
      const selected = selectedSelectionItems(selectionInput);
      fields.push(
        cleanRecord({
          name: asString(selectionInput.name),
          label: asString(selectionInput.label),
          type: asString(selectionInput.type),
          selected: selected.length > 0 ? selected : undefined,
        }),
      );
    }

    const pickerSummary = summarizeDateTimePicker(dateTimePicker);
    if (pickerSummary) {
      dateTimePickers.push(pickerSummary);
    }

    for (const button of asArray(buttonList?.buttons)) {
      const summary = summarizeButton(button);
      if (summary) {
        buttons.push(summary);
      }
    }

    if (divider) {
      dividers += 1;
    }

    const gridSummary = summarizeGrid(grid);
    if (gridSummary) {
      grids.push(gridSummary);
    }

    const columnsSummary = summarizeColumns(columnSet);
    if (columnsSummary) {
      columns.push(columnsSummary);
    }

    const carouselSummary = summarizeCarousel(carousel);
    if (carouselSummary) {
      carousels.push(carouselSummary);
    }

    for (const chip of asArray(chipList?.chips)) {
      const summary = summarizeChip(chip);
      if (summary) {
        chips.push(summary);
      }
    }
  }

  return cleanRecord({
    header: asString(raw?.header),
    widgetCount: widgets.length,
    text,
    fields,
    buttons,
    images: images.length > 0 ? images : undefined,
    dividers: dividers > 0 ? dividers : undefined,
    grids: grids.length > 0 ? grids : undefined,
    columns: columns.length > 0 ? columns : undefined,
    carousels: carousels.length > 0 ? carousels : undefined,
    dateTimePickers: dateTimePickers.length > 0 ? dateTimePickers : undefined,
    chips: chips.length > 0 ? chips : undefined,
  });
}

function formatPairs(parameters: Record<string, string>): string {
  return Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatButtonSummary(button: JsonRecord): string {
  const text = asString(button.text) ?? "Untitled";
  const openLink = asString(button.openLink);

  if (openLink) {
    return `${text} -> ${openLink}`;
  }

  const parameters = asRecord(button.parameters) as Record<string, string>;
  return `${text} -> ${button.function}(${formatPairs(parameters)})`;
}

function fieldValue(field: JsonRecord): string {
  const selected = asArray(field.selected)
    .filter((item): item is string => typeof item === "string")
    .join(", ");

  return asString(field.text) ?? selected;
}

function formatImageSummary(image: JsonRecord): string {
  const label = asString(image.altText) ?? asString(image.imageUrl) ?? "image";
  const openLink = asString(image.openLink);
  const functionName = asString(image.function);

  if (openLink) {
    return `${label} -> ${openLink}`;
  }

  if (functionName) {
    return `${label} -> ${functionName}(${formatPairs(
      (asRecord(image.parameters) as Record<string, string>) ?? {},
    )})`;
  }

  return label;
}

function formatGridSummary(grid: JsonRecord): string {
  const title = asString(grid.title) ?? "grid";
  const items = asArray(grid.items)
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null)
    .map((item) => {
      const itemTitle = asString(item.title) ?? asString(item.id) ?? "item";
      const subtitle = asString(item.subtitle);
      return subtitle ? `${itemTitle} (${subtitle})` : itemTitle;
    })
    .join("; ");

  return `Grid ${title}${items ? `: ${items}` : ""}`;
}

function formatColumnsSummary(columns: JsonRecord): string {
  const columnSummaries = asArray(columns.columns)
    .map((column, index) => {
      const summary = formatSectionSummary(asRecord(column) ?? {});
      return `column ${index + 1}: ${summary}`;
    })
    .join("; ");

  return `Columns: ${columnSummaries}`;
}

function formatCarouselSummary(carousel: JsonRecord): string {
  const cardSummaries = asArray(carousel.cards)
    .map((card, index) => {
      const raw = asRecord(card) ?? {};
      const widgets = trimTrailingPeriods(formatSectionSummary(asRecord(raw.widgets) ?? {}));
      const footer = trimTrailingPeriods(formatSectionSummary(asRecord(raw.footer) ?? {}));
      return `card ${index + 1}: ${widgets}${footer ? ` Footer: ${footer}` : ""}`;
    })
    .join("; ");

  return `Carousel: ${cardSummaries}`;
}

function trimTrailingPeriods(value: string): string {
  return value.replace(/[.]+$/u, "");
}

function formatDateTimePickerSummary(picker: JsonRecord): string {
  const label = asString(picker.label) ?? asString(picker.name) ?? "date/time";
  const type = asString(picker.type) ?? "UNKNOWN";
  const value = asString(picker.valueMsEpoch) ?? "";
  return `${label} ${type}=${value}`;
}

function formatChipSummary(chip: JsonRecord): string {
  const text = asString(chip.text) ?? "chip";
  const openLink = asString(chip.openLink);
  const functionName = asString(chip.function);

  if (openLink) {
    return `${text} -> ${openLink}`;
  }

  if (functionName) {
    return `${text} -> ${functionName}(${formatPairs(
      (asRecord(chip.parameters) as Record<string, string>) ?? {},
    )})`;
  }

  return text;
}

function formatSectionSummary(section: JsonRecord): string {
  const header = asString(section.header);
  const text = asArray(section.text).filter((item): item is string => typeof item === "string");
  const fields = asArray(section.fields)
    .map((field) => asRecord(field))
    .filter((field): field is JsonRecord => field !== null);
  const buttons = asArray(section.buttons)
    .map((button) => asRecord(button))
    .filter((button): button is JsonRecord => button !== null);
  const images = asArray(section.images)
    .map((image) => asRecord(image))
    .filter((image): image is JsonRecord => image !== null);
  const grids = asArray(section.grids)
    .map((grid) => asRecord(grid))
    .filter((grid): grid is JsonRecord => grid !== null);
  const columns = asArray(section.columns)
    .map((column) => asRecord(column))
    .filter((column): column is JsonRecord => column !== null);
  const carousels = asArray(section.carousels)
    .map((carousel) => asRecord(carousel))
    .filter((carousel): carousel is JsonRecord => carousel !== null);
  const dateTimePickers = asArray(section.dateTimePickers)
    .map((picker) => asRecord(picker))
    .filter((picker): picker is JsonRecord => picker !== null);
  const chips = asArray(section.chips)
    .map((chip) => asRecord(chip))
    .filter((chip): chip is JsonRecord => chip !== null);
  const parts: string[] = [];

  if (header) {
    parts.push(`Section ${header}.`);
  }

  if (text.length > 0) {
    parts.push(`Text: ${text.join(" ")}`);
  }

  if (fields.length > 0) {
    parts.push(
      `Fields: ${fields
        .map((field) => `${field.label}=${fieldValue(field)}`)
        .join("; ")}.`,
    );
  }

  if (buttons.length > 0) {
    parts.push(`Buttons: ${buttons.map(formatButtonSummary).join("; ")}.`);
  }

  if (images.length > 0) {
    parts.push(`Images: ${images.map(formatImageSummary).join("; ")}.`);
  }

  if (typeof section.dividers === "number" && section.dividers > 0) {
    parts.push(`Dividers: ${section.dividers}.`);
  }

  if (grids.length > 0) {
    parts.push(`${grids.map(formatGridSummary).join(" ")}.`);
  }

  if (columns.length > 0) {
    parts.push(`${columns.map(formatColumnsSummary).join("; ")}.`);
  }

  if (carousels.length > 0) {
    parts.push(`${carousels.map(formatCarouselSummary).join("; ")}.`);
  }

  if (dateTimePickers.length > 0) {
    parts.push(
      `Date/time pickers: ${dateTimePickers
        .map(formatDateTimePickerSummary)
        .join("; ")}.`,
    );
  }

  if (chips.length > 0) {
    parts.push(`Chips: ${chips.map(formatChipSummary).join("; ")}.`);
  }

  return parts.join(" ");
}

export function summarizeCards(cardsV2: unknown): JsonRecord {
  const cards = asArray(cardsV2).map((entry) => {
    const raw = asRecord(entry);
    const card = asRecord(raw?.card);
    const header = asRecord(card?.header);

    return {
      cardId: asString(raw?.cardId),
      title: asString(header?.title),
      subtitle: asString(header?.subtitle),
      sections: asArray(card?.sections).map(summarizeSection),
    };
  });
  const plainText = cards
    .map((card) => {
      const title = card.title ? `: ${card.title}` : "";
      const subtitle = card.subtitle ? ` (${card.subtitle})` : "";
      const sections = asArray(card.sections)
        .map((section) => asRecord(section))
        .filter((section): section is JsonRecord => section !== null);
      const sectionPart = sections.map(formatSectionSummary).filter(Boolean).join(" ");

      return `Card ${card.cardId}${title}${subtitle}${
        sectionPart ? `. ${sectionPart}` : ""
      }`;
    })
    .join("\n");

  return {
    cards,
    plainText,
  };
}

function normalizeActor(input: unknown): CardActionSummary["actor"] {
  const raw = asRecord(input);
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

function parseActionType(raw: JsonRecord, common: JsonRecord | null): CardActionSummary["actionType"] {
  if (raw.dialogEventType === "SUBMIT_DIALOG") {
    return "dialog_submit";
  }

  if (common?.eventType === "WIDGET_UPDATE" || common?.eventType === "WIDGET_UPDATED") {
    return "widget_update";
  }

  return "card_click";
}

function parseParameters(raw: JsonRecord, common: JsonRecord | null): Record<string, string> {
  const actionParameters = parametersObjectFromArray(asRecord(raw.action)?.parameters);
  const commonParameters = Object.fromEntries(
    sortedParameters(common?.parameters).map((item) => [item.key, item.value]),
  );

  return sortObject({
    ...actionParameters,
    ...commonParameters,
  });
}

function parseFormInput(input: unknown): FormInputSummary {
  const raw = asRecord(input);
  const stringInputs = asRecord(raw?.stringInputs);
  const values = asArray(stringInputs?.value).map((value) => String(value));

  if (values.length > 0) {
    return {
      kind: "string",
      values,
      value: values[0] ?? null,
    };
  }

  const dateInput = asRecord(raw?.dateInput);
  const timeInput = asRecord(raw?.timeInput);
  const dateTimeInput = asRecord(raw?.dateTimeInput);

  if (dateInput) {
    const value = asString(dateInput.msSinceEpoch) ?? String(dateInput.msSinceEpoch ?? "");
    return { kind: "date", values: value ? [value] : [], value: value || null };
  }

  if (timeInput) {
    const hours = String(timeInput.hours ?? "").padStart(2, "0");
    const minutes = String(timeInput.minutes ?? "").padStart(2, "0");
    const value = `${hours}:${minutes}`;
    return { kind: "time", values: [value], value };
  }

  if (dateTimeInput) {
    const value =
      asString(dateTimeInput.msSinceEpoch) ?? String(dateTimeInput.msSinceEpoch ?? "");
    return { kind: "date_time", values: value ? [value] : [], value: value || null };
  }

  return {
    kind: "unknown",
    values: [],
    value: null,
  };
}

function parseFormInputs(input: unknown): Record<string, FormInputSummary> {
  const raw = asRecord(input);

  if (!raw) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, parseFormInput(value)]),
  );
}

export function summarizeCardAction(event: unknown): CardActionSummary {
  const raw = asRecord(event);
  if (!raw) {
    throw new TypeError("Expected a Google Chat card action event object.");
  }

  const common = asRecord(raw.common);
  const action = asRecord(raw.action);

  return {
    actionType: parseActionType(raw, common),
    methodName:
      asString(common?.invokedFunction) ??
      asString(common?.triggeredFunction) ??
      asString(action?.actionMethodName),
    parameters: parseParameters(raw, common),
    formInputs: parseFormInputs(common?.formInputs),
    actor: normalizeActor(raw.user),
    eventTime: asString(raw.eventTime),
  };
}

function actorLabel(actor: CardActionSummary["actor"]): string {
  if (!actor) {
    return "Unknown actor";
  }

  if (actor.displayName) {
    return `${actor.displayName} (${actor.name})`;
  }

  return actor.name;
}

function actionPhrase(summary: CardActionSummary): string {
  const methodName = summary.methodName ?? "unknown action";

  if (summary.actionType === "dialog_submit") {
    return `submitted dialog ${methodName}`;
  }

  if (summary.actionType === "widget_update") {
    return `updated widget via ${methodName}`;
  }

  return `clicked card action ${methodName}`;
}

function buttonChoice(summary: CardActionSummary): string | null {
  if (summary.actionType !== "card_click") {
    return null;
  }

  for (const key of ["decision", "choice", "button", "action"]) {
    const value = summary.parameters[key];
    if (value) {
      return `${key}=${value}`;
    }
  }

  return null;
}

function formPairs(inputs: Record<string, FormInputSummary>): string {
  return Object.entries(inputs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, input]) => `${key}=${input.values.join(", ") || input.value || ""}`)
    .join("; ");
}

export function renderCardActionNote(summary: CardActionSummary): string {
  const parts = [
    `System Note: ${actorLabel(summary.actor)} ${actionPhrase(summary)} at ${
      summary.eventTime ?? "unknown time"
    }.`,
  ];
  const choice = buttonChoice(summary);
  const parameters = formatPairs(summary.parameters);
  const forms = formPairs(summary.formInputs);

  if (choice) {
    parts.push(`Button choice: ${choice}.`);
  }

  if (parameters) {
    parts.push(`Parameters: ${parameters}.`);
  }

  if (forms) {
    parts.push(`Form values: ${forms}.`);
  }

  return parts.join(" ");
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Card action state must be JSON serializable.");
  }
  return json;
}

export function encodeCardActionState(state: unknown): string {
  return `v1.${Buffer.from(compactJson(state), "utf8").toString("base64url")}`;
}

export function decodeCardActionState(encoded: string): unknown {
  if (typeof encoded !== "string" || !encoded.startsWith("v1.")) {
    throw new TypeError("Card action state must use the v1. base64url format.");
  }

  try {
    return JSON.parse(Buffer.from(encoded.slice(3), "base64url").toString("utf8"));
  } catch (error) {
    throw new TypeError(
      `Card action state could not be decoded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function withCardActionState(
  action: CardActionConfig,
  state: unknown,
  parameterName = DEFAULT_CARD_ACTION_STATE_PARAMETER,
): CardActionConfig {
  return {
    ...action,
    parameters: {
      ...(action.parameters ?? {}),
      [parameterName]: encodeCardActionState(state),
    },
  };
}

function isCardActionSummary(input: unknown): input is CardActionSummary {
  const raw = asRecord(input);
  return (
    (raw?.actionType === "card_click" ||
      raw?.actionType === "dialog_submit" ||
      raw?.actionType === "dialog_cancel" ||
      raw?.actionType === "widget_update") &&
    asRecord(raw.parameters) !== null &&
    asRecord(raw.formInputs) !== null
  );
}

function cardActionSummaryFrom(input: unknown): CardActionSummary {
  return isCardActionSummary(input) ? input : summarizeCardAction(input);
}

export function readCardActionState(
  input: unknown,
  parameterName = DEFAULT_CARD_ACTION_STATE_PARAMETER,
): unknown | null {
  const summary = cardActionSummaryFrom(input);
  const encoded = summary.parameters[parameterName];
  return encoded === undefined ? null : decodeCardActionState(encoded);
}

function routeKeyFor(actionType: CardActionSummary["actionType"]): keyof CardActionRouteHandlers<unknown> | null {
  if (actionType === "card_click") {
    return "cardClick";
  }
  if (actionType === "dialog_submit") {
    return "dialogSubmit";
  }
  if (actionType === "dialog_cancel") {
    return "dialogCancel";
  }
  if (actionType === "widget_update") {
    return "widgetUpdate";
  }
  return null;
}

export function routeCardAction<Result = unknown>(
  input: unknown,
  handlers: CardActionRouteHandlers<Result>,
): CardActionRouteResult<Result> {
  const summary = cardActionSummaryFrom(input);
  const methodHandler =
    summary.methodName !== null ? handlers.methods?.[summary.methodName] : undefined;

  if (methodHandler) {
    return {
      matched: true,
      route: `method:${summary.methodName}`,
      summary,
      result: methodHandler(summary),
    };
  }

  const routeKey = routeKeyFor(summary.actionType) as keyof CardActionRouteHandlers<Result> | null;
  const typeHandler = routeKey ? handlers[routeKey] : undefined;
  if (typeof typeHandler === "function") {
    return {
      matched: true,
      route: routeKey,
      summary,
      result: typeHandler(summary),
    };
  }

  if (handlers.unknown) {
    return {
      matched: true,
      route: "unknown",
      summary,
      result: handlers.unknown(summary),
    };
  }

  return {
    matched: false,
    route: null,
    summary,
    result: undefined,
  };
}
