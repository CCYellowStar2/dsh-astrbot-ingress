"""Pure-media send/quote regression tests; run alongside test_mention_routing."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from astrbot_plugin_dsh.main import At, DshBridgePlugin, Plain, Reply


class MediaQuoteTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.plugin = object.__new__(DshBridgePlugin)
        self.plugin.config = {
            "quote_continue": True,
            "official_at_continue": False,
            "bound_media_passthrough": False,
            "private_passthrough": False,
        }
        self.plugin._binding_cache = {"group": (True, 0)}
        self.plugin._quote_ids = set()
        self.plugin._quote_texts = []
        self.plugin._save_quote_ids = Mock()
        self.plugin._send_mode = Mock(return_value="direct")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def event(self, platform="qq_official"):
        return SimpleNamespace(
            get_platform_name=lambda: platform,
            get_group_id=lambda: "group",
            get_self_id=lambda: "me",
            unified_msg_origin="group",
            message_obj=SimpleNamespace(message=[At(qq="me")],
                                        raw_message=SimpleNamespace(raw_payload={})),
            chain_result=lambda chain: SimpleNamespace(chain=chain),
        )

    async def send_file(self, event, suffix, receipt):
        path = Path(self.temp.name) / ("media" + suffix)
        path.write_bytes(b"test")
        self.plugin._deliver = AsyncMock(return_value=receipt)
        self.assertEqual([item async for item in self.plugin._send_outbound_file(event, path, path.name)], [])
        return self.plugin._deliver.call_args.args[1].chain

    async def test_media_receipts_allow_id_based_quotes(self):
        for suffix in (".png", ".pdf", ".mp4"):
            for receipt in ({"id": "sent"}, {"message_id": "sent"},
                            SimpleNamespace(id="sent")):
                with self.subTest(suffix=suffix, receipt=receipt):
                    self.plugin._quote_ids.clear()
                    event = self.event("aiocqhttp")
                    await self.send_file(event, suffix, receipt)
                    event.message_obj.message.append(Reply(id="sent"))
                    self.assertEqual(self.plugin._should_capture(event, "continue"), (True, "continue"))
                    self.plugin.config["quote_continue"] = False
                    self.assertEqual(self.plugin._should_capture(event, "continue"), (False, ""))
                    self.plugin.config["quote_continue"] = True

    async def test_official_media_without_reference_ids_uses_existing_tag(self):
        for suffix in (".png", ".pdf", ".mp4"):
            with self.subTest(suffix=suffix):
                event = self.event()
                chain = await self.send_file(event, suffix, None)
                caption = "".join(seg.text for seg in chain if isinstance(seg, Plain))
                self.assertIn(self.plugin.OUTBOUND_TAG, caption)
                event.message_obj.raw_message.raw_payload = {
                    "msg_elements": [{"content": caption, "attachments": []}],
                }
                self.assertTrue(self.plugin._should_capture(event, "continue")[0])
                self.plugin.config["quote_continue"] = False
                self.assertFalse(self.plugin._should_capture(event, "continue")[0])
                self.plugin.config["quote_continue"] = True
                event.message_obj.message = [At(qq="other")]
                self.assertFalse(self.plugin._should_capture(event, "continue")[0])

    async def test_unrelated_media_and_failed_send_do_not_become_dsh_quotes(self):
        event = self.event()
        event.message_obj.message.append(Reply(id="unrelated"))
        self.assertFalse(self.plugin._should_capture(event, "continue")[0])
        event.message_obj.message = [At(qq="me")]
        event.message_obj.raw_message.raw_payload = {
            "msg_elements": [{"attachments": [{"content_type": "image/png",
                                               "url": "https://example.invalid/image"}]}],
        }
        self.assertFalse(self.plugin._should_capture(event, "continue")[0])
        self.plugin._deliver = AsyncMock(side_effect=RuntimeError("send failed"))
        path = Path(self.temp.name) / "media.pdf"
        path.write_bytes(b"test")
        self.assertTrue([item async for item in self.plugin._send_outbound_file(event, path, path.name)])
        self.assertEqual(self.plugin._quote_ids, set())
        self.plugin._save_quote_ids.assert_not_called()

    async def test_video_fallback_records_only_successful_file(self):
        event = self.event("aiocqhttp")
        path = Path(self.temp.name) / "media.mp4"
        path.write_bytes(b"test")
        self.plugin._deliver = AsyncMock(side_effect=[RuntimeError("video failed"), {"id": "fallback"}])
        self.assertEqual([item async for item in self.plugin._send_outbound_file(event, path, path.name)], [])
        self.assertEqual(self.plugin._quote_ids, {"fallback"})
        self.plugin._save_quote_ids.assert_called_once()
