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
