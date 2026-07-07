import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeEvent } from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

describe("normalizeEvent", () => {
  it("matches the shared event conformance fixtures", () => {
    const cases = readJson("conformance/cases/events.parse.json") as Array<{
      id: string;
      input: { fixture: string; source?: "chat_http" | "workspace_events" | "pubsub" | "fixture" };
      expect: { fixture: string };
    }>;

    for (const testCase of cases) {
      const raw = readJson(testCase.input.fixture);
      const expected = readJson(testCase.expect.fixture);
      const options = testCase.input.source ? { source: testCase.input.source } : {};

      expect(normalizeEvent(raw, options), testCase.id).toEqual(expected);
    }
  });

  it("normalizes message edge cases without losing raw payloads", () => {
    const missingText = readJson("fixtures/events/message-created/missing-text.json");
    const missingTextEvent = normalizeEvent(missingText, { source: "fixture" }) as any;

    expect(missingTextEvent.raw).toEqual(missingText);
    expect(missingTextEvent).toMatchObject({
      source: "fixture",
      kind: "message.created",
      rawKind: "MESSAGE",
      actorState: { status: "available", reason: null },
      message: {
        text: "",
        sender: { resourceName: "users/789", accessState: "available" },
        state: { threadReply: false },
      },
      relationship: {
        isThreadReply: false,
        isDirectReply: false,
        isQuote: false,
      },
    });

    const missingUser = readJson("fixtures/events/message-created/missing-user.json");
    const missingUserEvent = normalizeEvent(missingUser, { source: "fixture" }) as any;

    expect(missingUserEvent.raw).toEqual(missingUser);
    expect(missingUserEvent).toMatchObject({
      source: "fixture",
      kind: "message.created",
      actor: null,
      actorState: { status: "missing", reason: "event_payload_missing_user" },
      message: {
        text: "I arrived without user metadata",
        sender: null,
        state: { threadReply: false },
      },
    });

    const quotedReply = readJson("fixtures/events/message-created/quoted-reply.json");
    const quotedReplyEvent = normalizeEvent(quotedReply, { source: "fixture" }) as any;

    expect(quotedReplyEvent).toMatchObject({
      kind: "message.thread_reply",
      message: {
        state: { threadReply: true },
        contextNode: {
          children: [
            {
              relationship: "quoted_message",
              ref: { name: "spaces/AAA/messages/ROOT" },
              text: "Should we ship this?",
              sender: {
                resourceName: "users/456",
                displayName: "Grace Hopper",
              },
            },
          ],
        },
      },
      relationship: {
        isQuote: true,
        isDirectReply: true,
        isThreadReply: true,
      },
    });
  });

  it("classifies direct app interaction event families", () => {
    const slashEvent = normalizeEvent(
      readJson("fixtures/events/message-created/slash-command.json"),
      { source: "fixture" },
    ) as any;
    expect(slashEvent).toMatchObject({
      kind: "message.slash_command",
      action: {
        actionType: "slash_command",
        methodName: "/deploy",
        parameters: {
          commandId: "1",
          commandName: "/deploy",
        },
      },
      relationship: { isUserAction: true, isCardAction: false },
    });

    const appCommandEvent = normalizeEvent(
      readJson("fixtures/events/message-created/app-command.json"),
      { source: "fixture" },
    ) as any;
    expect(appCommandEvent).toMatchObject({
      kind: "message.app_command",
      action: {
        actionType: "app_command",
        methodName: "Summarize thread",
        parameters: {
          appCommandId: "summarize-thread",
          appCommandType: "USER",
        },
      },
    });

    expect(
      normalizeEvent(readJson("fixtures/events/space/added-to-space.json"), {
        source: "fixture",
      }),
    ).toMatchObject({ kind: "space.added", relationship: { isSpaceEvent: true } });
    expect(
      normalizeEvent(readJson("fixtures/events/space/removed-from-space.json"), {
        source: "fixture",
      }),
    ).toMatchObject({ kind: "space.removed", relationship: { isSpaceEvent: true } });

    const mentionedAppEvent = normalizeEvent(
      readJson("fixtures/events/message-created/mentioned-app.json"),
      { source: "fixture" },
    ) as any;
    expect(mentionedAppEvent).toMatchObject({
      kind: "message.mentioned_app",
      message: {
        argumentText: "help me summarize",
      },
      relationship: { isUserAction: true },
    });
    expect(mentionedAppEvent.message.plainTextForModel).toContain(
      "@Google Chat AI SDK Dev help me summarize",
    );
  });

  it("normalizes card, dialog, and widget actions", () => {
    const cardEvent = normalizeEvent(readJson("fixtures/events/card/click.json"), {
      source: "fixture",
    }) as any;
    expect(cardEvent).toMatchObject({
      kind: "card.clicked",
      action: {
        actionType: "card_click",
        methodName: "approve_incident",
        parameters: {
          incident: "INC-1",
          source: "card",
        },
        formInputs: {},
      },
      relationship: { isCardAction: true },
    });

    const dialogEvent = normalizeEvent(
      readJson("fixtures/events/card/dialog-submit.json"),
      { source: "fixture" },
    ) as any;
    expect(dialogEvent).toMatchObject({
      kind: "dialog.submitted",
      locale: "en-US",
      timeZone: "America/New_York",
      action: {
        actionType: "dialog_submit",
        methodName: "submit_incident_dialog",
        formInputs: {
          decision: { kind: "string", values: ["approve"], value: "approve" },
          notes: { kind: "string", values: ["Ship it"], value: "Ship it" },
        },
      },
      dialog: { eventType: "SUBMIT_DIALOG" },
    });

    const widgetEvent = normalizeEvent(readJson("fixtures/events/card/widget-update.json"), {
      source: "fixture",
    }) as any;
    expect(widgetEvent).toMatchObject({
      kind: "widget.updated",
      action: {
        actionType: "widget_update",
        methodName: "assignee_autocomplete",
        parameters: { query: "ada" },
      },
    });

    const dialogOpenedEvent = normalizeEvent(
      readJson("fixtures/events/card/dialog-opened.json"),
      { source: "fixture" },
    ) as any;
    expect(dialogOpenedEvent).toMatchObject({
      kind: "dialog.opened",
      dialog: { eventType: "REQUEST_DIALOG" },
      action: {
        actionType: "card_click",
        methodName: "open_incident_dialog",
      },
    });

    const dialogCancelledEvent = normalizeEvent(
      readJson("fixtures/events/card/dialog-cancelled.json"),
      { source: "fixture" },
    ) as any;
    expect(dialogCancelledEvent).toMatchObject({
      kind: "dialog.cancelled",
      dialog: { eventType: "CANCEL_DIALOG" },
      action: {
        actionType: "dialog_cancel",
        methodName: "cancel_incident_dialog",
      },
    });
  });

  it("unwraps Pub/Sub events and Workspace Events wrappers", () => {
    const pubsubEvent = normalizeEvent(
      readJson("fixtures/events/pubsub/direct-message.json"),
    ) as any;
    expect(pubsubEvent).toMatchObject({
      eventId: "pubsub:1001",
      source: "pubsub",
      kind: "message.direct",
      transport: {
        kind: "pubsub",
        pubsubMessageId: "1001",
        pubsubPublishTime: "2026-06-29T18:20:01Z",
        pubsubDeliveryAttempt: "1",
      },
      message: { text: "hello from pubsub" },
    });

    const updatedEvent = normalizeEvent(
      readJson("fixtures/events/workspace/message-updated.json"),
    ) as any;
    expect(updatedEvent).toMatchObject({
      eventId: "workspace_events:workspace-event-1",
      source: "workspace_events",
      kind: "message.updated",
      rawKind: "google.workspace.chat.message.v1.updated",
      relationship: { isEdit: true },
      message: {
        updatedAt: "2026-06-29T18:30:00Z",
        text: "edited copy",
      },
    });

    const pubsubWorkspaceEvent = normalizeEvent(
      readJson("fixtures/events/pubsub/workspace-message-updated.json"),
    ) as any;
    expect(pubsubWorkspaceEvent).toMatchObject({
      eventId: "workspace_events:workspace-pubsub-event-1",
      source: "workspace_events",
      kind: "message.updated",
      transport: {
        kind: "workspace_events",
        pubsubMessageId: "1002",
        workspaceEventType: "google.workspace.chat.message.v1.updated",
      },
      message: {
        text: "workspace pubsub edited copy",
        updatedAt: "2026-06-29T18:36:00Z",
      },
    });

    const deletedEvent = normalizeEvent(
      readJson("fixtures/events/workspace/message-deleted.json"),
    ) as any;
    expect(deletedEvent).toMatchObject({
      source: "workspace_events",
      kind: "message.deleted",
      relationship: { isDeletion: true },
      message: {
        state: { deleted: true },
        deletedAt: "2026-06-29T18:31:00Z",
        systemNotes: expect.arrayContaining([
          "System Note: Message was deleted at 2026-06-29T18:31:00Z (USER_DELETED).",
        ]),
      },
    });
  });

  it("normalizes reaction and membership Workspace Events", () => {
    const reactionEvent = normalizeEvent(
      readJson("fixtures/events/workspace/reaction-created.json"),
    ) as any;
    expect(reactionEvent).toMatchObject({
      kind: "reaction.created",
      actor: {
        name: "users/456",
        displayName: "Grace Hopper",
        email: "grace@example.com",
      },
      reaction: {
        ref: { name: "spaces/AAA/messages/BBB/reactions/reaction-1" },
        emoji: { unicode: "👍" },
        messageRef: { name: "spaces/AAA/messages/BBB" },
      },
      relationship: { isReaction: true },
    });

    const reactionDeletedEvent = normalizeEvent(
      readJson("fixtures/events/workspace/reaction-deleted.json"),
    ) as any;
    expect(reactionDeletedEvent).toMatchObject({
      kind: "reaction.deleted",
      reaction: {
        deletedAt: "2026-06-29T18:34:00Z",
      },
      relationship: { isReaction: true },
    });

    const membershipEvent = normalizeEvent(
      readJson("fixtures/events/workspace/membership-deleted.json"),
    ) as any;
    expect(membershipEvent).toMatchObject({
      kind: "membership.deleted",
      membership: {
        ref: { name: "spaces/AAA/members/users/999" },
        state: "NOT_A_MEMBER",
        member: {
          name: "users/999",
          access: { status: "access_limited" },
        },
      },
      relationship: { isMembershipEvent: true },
    });

    const membershipCreatedEvent = normalizeEvent(
      readJson("fixtures/events/workspace/membership-created.json"),
    ) as any;
    expect(membershipCreatedEvent).toMatchObject({
      kind: "membership.created",
      membership: {
        state: "JOINED",
        member: {
          displayName: "Katherine Johnson",
          email: "katherine@example.com",
        },
      },
      relationship: { isMembershipEvent: true },
    });

    const membershipUpdatedEvent = normalizeEvent(
      readJson("fixtures/events/workspace/membership-updated.json"),
    ) as any;
    expect(membershipUpdatedEvent).toMatchObject({
      kind: "membership.updated",
      membership: {
        state: "JOINED",
      },
      relationship: { isMembershipEvent: true },
    });
  });

  it("returns event.unknown for unknown event types", () => {
    const event = normalizeEvent(readJson("fixtures/events/unknown/unknown-type.json"), {
      source: "fixture",
    }) as any;

    expect(event).toMatchObject({
      kind: "event.unknown",
      rawKind: "MYSTERY_EVENT",
      message: null,
      action: null,
    });
  });

  it("throws a typed error for invalid non-object payloads", () => {
    try {
      normalizeEvent("not an object" as unknown);
      throw new Error("normalizeEvent unexpectedly accepted an invalid payload");
    } catch (error) {
      expect((error as Error).name).toBe("InvalidChatEventError");
      expect(error).toBeInstanceOf(TypeError);
    }
  });
});
