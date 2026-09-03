import unittest

from googlechatai import (
    explain_chat_capability,
    explain_google_chat_error,
    plan_chat_permission,
)


class CapabilitiesTest(unittest.TestCase):
    def test_explains_app_auth_reply_capability(self):
        explanation = explain_chat_capability(
            "messages.reply", {"principal": "app"}
        )

        self.assertEqual(explanation["kind"], "chat.capability_explanation")
        self.assertEqual(explanation["googleMethod"], "spaces.messages.create")
        self.assertTrue(explanation["ok"])
        self.assertEqual(explanation["principal"], "app")
        self.assertEqual(explanation["supportedPrincipals"], ["app"])

    def test_plans_user_auth_reaction_permission(self):
        plan = plan_chat_permission("reactions.add", {"principal": "app"})

        self.assertFalse(plan["ok"])
        self.assertIn("unsupported_principal", plan["reasons"])
        self.assertIn("submitting user's OAuth token", " ".join(plan["remediation"]))

    def test_describes_message_pins_as_user_authorized_developer_preview(self):
        readable = explain_chat_capability("pins.list", {"principal": "user"})
        writable = plan_chat_permission(
            "spaces.messagePins.create", {"principal": "app"}
        )

        self.assertEqual(readable["intent"], "pins.list")
        self.assertEqual(readable["googleMethod"], "spaces.messagePins.list")
        self.assertTrue(readable["ok"])
        self.assertEqual(readable["principal"], "user")
        self.assertEqual(
            readable["requiredScopes"],
            ["https://www.googleapis.com/auth/chat.spaces.pins.readonly"],
        )
        self.assertTrue(readable["liveSafe"])
        self.assertIn(
            "Message pins are a Google Workspace Developer Preview surface.",
            readable["knownLimitations"],
        )
        self.assertEqual(writable["intent"], "pins.create")
        self.assertFalse(writable["ok"])
        self.assertEqual(writable["principal"], "app")
        self.assertEqual(writable["supportedPrincipals"], ["user"])
        self.assertEqual(
            writable["requiredScopes"],
            ["https://www.googleapis.com/auth/chat.spaces.pins"],
        )
        self.assertIn("calling user's OAuth token", " ".join(writable["remediation"]))

    def test_classifies_insufficient_scopes(self):
        explanation = explain_google_chat_error(
            {
                "httpStatus": 403,
                "body": {
                    "error": {
                        "status": "PERMISSION_DENIED",
                        "message": "Request had insufficient authentication scopes.",
                    }
                },
            },
            {
                "intent": "messages.read_context",
                "principal": "user",
                "requiredScopes": [
                    "https://www.googleapis.com/auth/chat.messages.readonly"
                ],
            },
        )

        self.assertEqual(explanation["code"], "insufficient_scopes")
        self.assertFalse(explanation["retryable"])
        self.assertIn(
            "do not switch to domain-wide delegation by default",
            " ".join(explanation["remediation"]),
        )


if __name__ == "__main__":
    unittest.main()
