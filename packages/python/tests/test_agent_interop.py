import json
import pathlib
import unittest

from googlechatai import normalize_agent_response, plan_agent_response_message


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


class AgentInteropTests(unittest.TestCase):
    def test_normalizes_anthropic_content_blocks(self) -> None:
        self.assertEqual(
            normalize_agent_response(read_json("fixtures/agent-interop/anthropic-content-blocks.json")),
            read_json("fixtures/expected/agent-interop/anthropic-content-blocks.normalized.json"),
        )

    def test_normalizes_openai_agents_run_result(self) -> None:
        self.assertEqual(
            normalize_agent_response(read_json("fixtures/agent-interop/openai-agents-run-result.json")),
            read_json("fixtures/expected/agent-interop/openai-agents-run-result.normalized.json"),
        )

    def test_normalizes_vercel_ai_sdk_result(self) -> None:
        self.assertEqual(
            normalize_agent_response(read_json("fixtures/agent-interop/vercel-ai-sdk-result.json")),
            read_json("fixtures/expected/agent-interop/vercel-ai-sdk-result.normalized.json"),
        )

    def test_normalizes_google_genai_grounding(self) -> None:
        self.assertEqual(
            normalize_agent_response(read_json("fixtures/agent-interop/google-genai-grounding.json")),
            read_json("fixtures/expected/agent-interop/google-genai-grounding.normalized.json"),
        )

    def test_plans_google_chat_messages_from_vercel_ai_sdk_result(self) -> None:
        self.assertEqual(
            plan_agent_response_message(
                read_json("fixtures/agent-interop/vercel-ai-sdk-result.json"),
                {"responseId": "resp_vercel_1"},
            ),
            read_json("fixtures/expected/agent-interop/vercel-ai-sdk-result.message-plan.json"),
        )

    def test_provider_override_preserves_detected_sdk_and_zero_cost(self) -> None:
        input_payload = read_json("fixtures/agent-interop/vercel-ai-sdk-result.json")
        input_payload["providerMetadata"] = {
            "aicost": {
                "totalCostUsd": 0,
                "currency": "USD",
                "source": "ai-sdk-cost",
            }
        }

        actual = normalize_agent_response(input_payload, {"provider": "gateway-proxy"})

        self.assertEqual(actual["provider"], "gateway-proxy")
        self.assertEqual(actual["sdk"], "vercel-ai-sdk")
        self.assertEqual(
            actual["cost"],
            {
                "amountUsd": 0,
                "currency": "USD",
                "source": "ai-sdk-cost",
                "note": None,
            },
        )


if __name__ == "__main__":
    unittest.main()
