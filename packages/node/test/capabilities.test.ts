import { describe, expect, it } from "vitest";

import {
  explainChatCapability,
  explainGoogleChatError,
  planChatPermission,
} from "../src/index.js";

describe("capability and error explainers", () => {
  it("explains app-auth reply capability", () => {
    expect(
      explainChatCapability("messages.reply", { principal: "app" }),
    ).toMatchObject({
      kind: "chat.capability_explanation",
      intent: "messages.reply",
      googleMethod: "spaces.messages.create",
      ok: true,
      principal: "app",
      supportedPrincipals: ["app"],
      requiredScopes: ["https://www.googleapis.com/auth/chat.bot"],
      membership: "app_must_be_member",
    });
  });

  it("plans user-auth reaction permission instead of app-auth fallback", () => {
    const plan = planChatPermission("reactions.add", { principal: "app" });

    expect(plan.ok).toBe(false);
    expect(plan.reasons).toContain("unsupported_principal");
    expect(plan.remediation.join(" ")).toContain("submitting user's OAuth token");
  });

  it("describes message pins as a user-authorized Developer Preview surface", () => {
    const readable = explainChatCapability("pins.list", { principal: "user" });
    const writable = planChatPermission("spaces.messagePins.create", {
      principal: "app",
    });

    expect(readable).toMatchObject({
      intent: "pins.list",
      googleMethod: "spaces.messagePins.list",
      ok: true,
      principal: "user",
      requiredScopes: [
        "https://www.googleapis.com/auth/chat.spaces.pins.readonly",
      ],
      liveSafe: true,
    });
    expect(readable.knownLimitations).toContain(
      "Message pins are a Google Workspace Developer Preview surface.",
    );
    expect(writable).toMatchObject({
      intent: "pins.create",
      ok: false,
      principal: "app",
      supportedPrincipals: ["user"],
      requiredScopes: ["https://www.googleapis.com/auth/chat.spaces.pins"],
    });
    expect(writable.remediation.join(" ")).toContain("calling user's OAuth token");
  });

  it("classifies insufficient scopes without suggesting domain-wide delegation", () => {
    const explanation = explainGoogleChatError(
      {
        httpStatus: 403,
        body: {
          error: {
            status: "PERMISSION_DENIED",
            message: "Request had insufficient authentication scopes.",
          },
        },
      },
      {
        intent: "messages.read_context",
        principal: "user",
        requiredScopes: [
          "https://www.googleapis.com/auth/chat.messages.readonly",
        ],
      },
    );

    expect(explanation.code).toBe("insufficient_scopes");
    expect(explanation.retryable).toBe(false);
    expect(explanation.remediation.join(" ")).toContain(
      "do not switch to domain-wide delegation by default",
    );
  });
});
