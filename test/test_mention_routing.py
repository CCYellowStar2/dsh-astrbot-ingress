"""Run with AstrBot installed: python -m unittest discover -s test -p 'test_*.py'."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from astrbot_plugin_dsh.main import At, DshBridgePlugin


class MentionRoutingTest(unittest.TestCase):
    def setUp(self):
        self.plugin = object.__new__(DshBridgePlugin)
        self.plugin.config = dict.fromkeys(
            ("quote_continue", "official_at_continue", "bound_media_passthrough", "private_passthrough"),
            False,
        )
        self.plugin._binding_cache = {"group": (True, 0)}

    def event(self, at_ids, self_id="", mentions=None):
        payload = {
            "mentions": mentions,
            "msg_elements": [{"attachments": [{"url": "https://example.invalid/img", "content_type": "image/png"}]}],
        }
        return SimpleNamespace(
            get_self_id=lambda: self_id,
            get_platform_name=lambda: "qq_official",
            get_group_id=lambda: "group",
            unified_msg_origin="group",
            message_obj=SimpleNamespace(message=[At(qq=q) for q in at_ids],
                                        raw_message=SimpleNamespace(raw_payload=payload)),
        )

    def test_quoted_image_only_addressed_to_another_member(self):
        event = self.event(["member"])
        self.assertEqual(self.plugin._should_capture(event, "ordinary text"), (False, ""))
        event.get_self_id = Mock(side_effect=ValueError)
        self.assertFalse(self.plugin._should_capture(event, "ordinary text")[0])

    def test_explicit_bot_mention_respects_continuation_switch(self):
        for event in (self.event(["qq_official"]), self.event(["me"], "me"),
                      self.event(["me"], mentions=[{"id": "me", "is_you": True}])):
            with self.subTest(event=event):
                self.assertEqual(self.plugin._should_capture(event, "describe"), (False, ""))
                self.assertFalse(self.plugin._mention_targets(event)[1])
                self.plugin.config["official_at_continue"] = True
                self.assertEqual(self.plugin._should_capture(event, "describe"), (True, "describe"))
                self.plugin.config["official_at_continue"] = False

    def test_mixed_mentions_and_other_bot(self):
        mentions = [{"id": "me", "is_you": True}, {"id": "other-bot", "bot": True}]
        for raw in (mentions, str(mentions)):
            event = self.event([], mentions=raw)
            self.assertTrue(self.plugin._mention_targets(event)[0])
            self.assertTrue(self.plugin._mention_targets(event)[1])
        event = self.event(["other-bot"], mentions=mentions[1:])
        self.assertFalse(self.plugin._mention_targets(event)[0])
        self.assertTrue(self.plugin._mention_targets(event)[1])

    def test_explicit_command_with_quoted_media_still_works(self):
        event = self.event(["qq_official"])
        self.assertEqual(self.plugin._should_capture(event, "/dsh describe"), (True, "describe"))

    def test_plain_bot_mention_with_switches_off_stays_with_persona(self):
        event = self.event(["qq_official"])
        event.message_obj.raw_message.raw_payload.pop("msg_elements")
        self.assertEqual(self.plugin._should_capture(event, "reply received"), (False, ""))

    def test_explicit_commands_precede_every_continuation(self):
        self.plugin.config.update(quote_continue=True, official_at_continue=True,
                                  bound_media_passthrough=True, command="bridge")
        event = self.event(["qq_official", "other"])
        element = event.message_obj.raw_message.raw_payload["msg_elements"][0]
        element["content"] = self.plugin.OUTBOUND_TAG + "DSH"
        for text, payload in (("/BRIDGE status", "status"), ("bridge follow", "follow"),
                              ("/bridge Read Me", "Read Me"), ("/bridge", "请查看附件")):
            with self.subTest(text=text):
                self.assertEqual(self.plugin._should_capture(event, text), (True, payload))
        self.assertFalse(self.plugin._is_explicit_bridge_command("/bridgeX status"))

    def test_group_mentions_of_others_block_implicit_routes(self):
        self.plugin.config.update(quote_continue=True, official_at_continue=True,
                                  bound_media_passthrough=True)
        for targets in (["other"], ["qq_official", "other"]):
            event = self.event(targets)
            element = event.message_obj.raw_message.raw_payload["msg_elements"][0]
            element["content"] = self.plugin.OUTBOUND_TAG + "DSH"
            for text in ("continue", "1", ""):
                with self.subTest(targets=targets, text=text):
                    self.assertEqual(self.plugin._should_capture(event, text), (False, ""))
        self.assertEqual(self.plugin._should_capture(self.event([]), "1"), (True, "1"))

    def test_private_synthetic_at_does_not_enable_group_continuation(self):
        self.plugin.config["official_at_continue"] = True
        event = self.event(["qq_official"])
        event.get_group_id = lambda: ""
        event.message_obj.raw_message.raw_payload.clear()
        self.assertEqual(self.plugin._should_capture(event, "hello"), (False, ""))
        self.assertEqual(self.plugin._should_capture(event, "/dsh status"), (True, "status"))
        self.plugin.config["private_passthrough"] = True
        self.assertEqual(self.plugin._should_capture(event, "hello"), (True, "hello"))
