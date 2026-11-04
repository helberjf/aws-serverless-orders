import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "smoke", Path(__file__).resolve().parents[2] / "scripts/smoke-test.py"
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class QueueInspectionTests(unittest.TestCase):
    def test_searches_past_old_messages_then_restores_entire_batch(self):
        client = Mock()
        client.receive_message.side_effect = [
            {"Messages": [{"Body": "invalid", "ReceiptHandle": "old"}]},
            {
                "Messages": [
                    {"Body": '{"target":true}', "ReceiptHandle": "target"},
                    {"Body": "{}", "ReceiptHandle": "later"},
                ]
            },
        ]
        result = smoke.wait_for_message(
            client, "queue", lambda body: body.get("target"), 30
        )
        self.assertTrue(result["target"])
        self.assertEqual(
            [call[0] for call in client.method_calls],
            [
                "receive_message",
                "receive_message",
                "change_message_visibility",
                "change_message_visibility",
                "change_message_visibility",
            ],
        )
        self.assertEqual(
            {
                call.kwargs["ReceiptHandle"]
                for call in client.change_message_visibility.call_args_list
            },
            {"old", "target", "later"},
        )
        client.delete_message.assert_not_called()

    def test_timeout_restores_unmatched_messages(self):
        client = Mock()
        client.receive_message.return_value = {
            "Messages": [{"Body": "{}", "ReceiptHandle": "old"}]
        }
        with patch.object(smoke.time, "monotonic", side_effect=[0, 0, 20]):
            with self.assertRaises(TimeoutError):
                smoke.wait_for_message(client, "queue", lambda body: False, 10)
        client.change_message_visibility.assert_called_once_with(
            QueueUrl="queue", ReceiptHandle="old", VisibilityTimeout=0
        )

    def test_restore_failure_attempts_remaining_handles_and_fails_the_check(self):
        client = Mock()
        client.receive_message.return_value = {
            "Messages": [
                {"Body": '{"target":true}', "ReceiptHandle": "target"},
                {"Body": "{}", "ReceiptHandle": "other"},
            ]
        }
        client.change_message_visibility.side_effect = [
            RuntimeError("temporary API failure"),
            {},
        ]
        with self.assertRaisesRegex(RuntimeError, "Could not restore"):
            smoke.wait_for_message(client, "queue", lambda body: body.get("target"), 30)
        self.assertEqual(client.change_message_visibility.call_count, 2)


if __name__ == "__main__":
    unittest.main()
