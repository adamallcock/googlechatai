import type { NormalizedMessageAst } from "./message-ast/index.js";
export type { NormalizedAttachment } from "./attachments/index.js";

export type ChatEventSource = "chat_http" | "workspace_events" | "pubsub" | "fixture";

export type ChatEventKind =
  | "message.created"
  | "message.updated"
  | "message.deleted"
  | "message.mentioned_app"
  | "message.direct"
  | "message.thread_reply"
  | "message.slash_command"
  | "message.app_command"
  | "message.link_preview_requested"
  | "message.unknown_command"
  | "space.added"
  | "space.removed"
  | "space.updated"
  | "space.deleted"
  | "membership.created"
  | "membership.updated"
  | "membership.deleted"
  | "reaction.created"
  | "reaction.deleted"
  | "card.clicked"
  | "dialog.opened"
  | "dialog.submitted"
  | "dialog.cancelled"
  | "widget.updated"
  | "event.batch"
  | "event.unknown";

export interface IdentityAccessState {
  status: "available" | "access_limited" | "missing";
  reason: string | null;
}

export interface ChatUserRef {
  name: string;
  displayName: string | null;
  email?: string | null;
  type: string | null;
  isApp?: boolean;
  access?: IdentityAccessState;
}

export interface ChatSpaceRef {
  name: string;
  displayName: string | null;
  type: string | null;
  spaceType?: string | null;
}

export interface ChatThreadRef {
  name: string;
  threadKey?: string | null;
}

export interface ChatMessageRef {
  name: string;
}

export interface UserMention {
  user: ChatUserRef;
  startIndex: number | null;
  length: number | null;
  mentionType: string | null;
}

export type NormalizedMessage = NormalizedMessageAst;

export type NormalizedActionType =
  | "slash_command"
  | "app_command"
  | "card_click"
  | "dialog_submit"
  | "dialog_cancel"
  | "widget_update"
  | "link_preview";

export interface ValidationError {
  field: string | null;
  code: string;
  message: string;
}

export type FormInputValue =
  | {
      kind: "string";
      value: string | null;
      values: string[];
      raw: unknown;
    }
  | {
      kind: "multi_select";
      value: string[];
      values: string[];
      raw: unknown;
    }
  | {
      kind: "boolean";
      value: boolean;
      values: string[];
      raw: unknown;
    }
  | {
      kind: "date";
      value: string | null;
      msSinceEpoch: string | null;
      raw: unknown;
    }
  | {
      kind: "time";
      value: string | null;
      raw: unknown;
    }
  | {
      kind: "date_time";
      value: string | null;
      msSinceEpoch: string | null;
      raw: unknown;
    }
  | {
      kind: "user_picker";
      value: ChatUserRef[];
      values: string[];
      raw: unknown;
    }
  | {
      kind: "space_picker";
      value: ChatSpaceRef[];
      values: string[];
      raw: unknown;
    }
  | {
      kind: "unknown";
      value: null;
      raw: unknown;
    };

export interface NormalizedAction {
  actionId: string;
  actionType: NormalizedActionType;
  methodName: string | null;
  actor: ChatUserRef | null;
  eventTime: string | null;
  parameters: Record<string, string>;
  formInputs: Record<string, FormInputValue>;
  selectedUsers: ChatUserRef[];
  selectedSpaces: ChatSpaceRef[];
  validationErrors: ValidationError[];
  systemNotes: string[];
  raw: unknown;
}

export type WorkspaceEventsAvailability = "available" | "access_limited" | "unavailable";

export interface WorkspaceEventsResourceRef {
  type: string | null;
  name: string | null;
  service: string | null;
  availability: WorkspaceEventsAvailability;
}

export interface WorkspaceEventMetadata {
  id: string | null;
  type: string | null;
  source: string | null;
  subject: string | null;
  time: string | null;
  subscription: string | null;
  resource: WorkspaceEventsResourceRef;
  actor: ChatUserRef | null;
  actorAvailability: WorkspaceEventsAvailability;
  resourceDataAvailability: WorkspaceEventsAvailability;
}

export interface WorkspaceEventsCheckpoint {
  type: "pubsub";
  cursor: string;
  ackId: string | null;
  messageId: string | null;
  subscription: string | null;
  publishTime: string | null;
  deliveryAttempt: number | null;
  orderingKey: string | null;
}

export interface PubSubEventMetadata {
  messageId: string | null;
  publishTime: string | null;
  subscription: string | null;
  orderingKey: string | null;
  deliveryAttempt: number | null;
  attributes: Record<string, string>;
  checkpoint: WorkspaceEventsCheckpoint;
}

export interface ChatEventEnvelope {
  eventId: string;
  receivedAt: string;
  source: ChatEventSource;
  kind: ChatEventKind;
  rawKind: string | null;
  actor: ChatUserRef | null;
  actorState: IdentityAccessState;
  space: ChatSpaceRef | null;
  thread: ChatThreadRef | null;
  message: NormalizedMessage | null;
  action: NormalizedAction | null;
  dialog: Record<string, unknown> | null;
  membership: Record<string, unknown> | null;
  reaction: Record<string, unknown> | null;
  locale: string | null;
  timeZone: string | null;
  authContext: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  relationship: Record<string, unknown>;
  transport: Record<string, unknown>;
  idempotencyKey: string;
  raw: unknown;
  workspaceEvent?: WorkspaceEventMetadata;
  pubSub?: PubSubEventMetadata;
}

export interface NormalizeEventOptions {
  source?: ChatEventSource;
  receivedAt?: string;
}

export interface PubSubNormalizeEventOptions extends NormalizeEventOptions {
  subscription?: string | null;
}
