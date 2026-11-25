"""QQ menu metadata controls only the current authorized private message."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from astrbot_plugin_dsh.main import At, DshBridgePlugin, Image, Reply


class PrivateMenuTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.plugin = object.__new__(DshBridgePlugin)
        self.plugin.config = {"command": "ops", "private_passthrough": False, "bound_media_passthrough": False}
        self.plugin._quote_ids = {"dsh-reply"}
        self.plugin._quote_texts = []
        self.plugin._umo_is_bound = Mock(return_value=True)
        self.event = SimpleNamespace(
            message_obj=SimpleNamespace(message=[At(qq="qq_official")],
                                        raw_message=SimpleNamespace(raw_data={})),
            get_group_id=lambda: "", get_platform_name=lambda: "qq_official",
            get_self_id=lambda: "qq_official", get_sender_id=lambda: "test-user",
            is_admin=lambda: True, unified_msg_origin="private-test", message_str="hello",
        )

    def route(self, text, ext):
        self.event.message_obj.raw_message.raw_data = {"message_scene": {"ext": ext}}
        return self.plugin._should_capture(self.event, text)

    def test_current_message_controls_routing_and_explicit_command(self):
        self.assertEqual(self.route("hello", ["msg_idx=123", "dsh_mode=1"]), (True, "hello"))
        self.assertEqual(self.route("/ops status", ["dsh_mode=1"]), (True, "status"))
        self.assertEqual(self.route("hello", ["msg_idx=124"]), (False, ""))
        self.assertEqual(self.route("/ops help", []), (True, "help"))
        self.assertEqual(self.route("", ["dsh_mode=1"]), (False, ""))
        self.event.message_obj.message.append(Image.fromURL("https://example.invalid/test.png"))
        self.assertEqual(self.route("", ["dsh_mode=1"]), (True, "请查看附件"))

    def test_rejects_untrusted_text_malformed_metadata_and_other_platforms(self):
        for ext in (None, {}, "dsh_mode=1", ["other_dsh_mode=1"], ["dsh_mode=10"], ["dsh_mode=0"]):
            self.assertEqual(self.route("dsh_mode=1", ext), (False, ""))
        self.event.get_platform_name = lambda: "aiocqhttp"
        self.assertEqual(self.route("hello", ["dsh_mode=1"]), (False, ""))
        self.event.get_platform_name = lambda: "qq_official_webhook"
        self.assertEqual(self.route("hello", ["dsh_mode=1"]), (True, "hello"))
        self.event.get_group_id = lambda: "group"
        self.assertFalse(self.plugin._qq_private_dsh_mode(self.event))

    def test_existing_command_and_quote_rules_in_both_menu_states(self):
        self.plugin.config["command"] = "yes"
        self.event.message_obj.message.append(Reply(id="dsh-reply"))
        for ext in ([], ["dsh_mode=1"]):
            with self.subTest(ext=ext):
                self.assertEqual(self.route("", ext), (True, "(继续)"))
                self.assertEqual(self.route("/yes", ext), (True, "status"))
                self.assertEqual(self.route("/yes stop", ext), (True, "stop"))

    async def test_mode_does_not_grant_permission(self):
        self.assertEqual(self.route("hello", ["dsh_mode=1"]), (True, "hello"))
        self.event.is_admin = lambda: False
        self.plugin._refresh_binding = AsyncMock()
        self.plugin._forward = Mock(side_effect=AssertionError("unauthorized DSH call"))
        self.assertEqual([reply async for reply in self.plugin.on_message(self.event)], [])
        self.plugin._forward.assert_not_called()
