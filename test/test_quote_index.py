import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from astrbot.api.star import StarTools
from astrbot_plugin_dsh.main import DshBridgePlugin


class QuoteIndexTest(unittest.TestCase):
    def setUp(self):
        shim = patch.object(DshBridgePlugin, "_install_botpy_raw_payload_shim")
        shim.start()
        self.addCleanup(shim.stop)

    def test_index_survives_reload_with_separate_data_root(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, ASTRBOT_ROOT=folder):
            index = Path(folder).resolve() / "data/plugin_data/astrbot_plugin_dsh/quoted_ids.json"
            first = DshBridgePlugin(None)
            self.assertEqual(first._quote_file, index)
            first._remember_outbound("example-id", "example response")
            self.assertTrue(index.is_file())

            second = DshBridgePlugin(None)
            self.assertTrue(second._quoted_is_dsh_content(SimpleNamespace(id="example-id")))
            self.assertTrue(second._quoted_is_dsh_content(SimpleNamespace(message_str="example response")))
            self.assertFalse(second._quoted_is_dsh_content(SimpleNamespace(message_str="unrelated")))

    def test_unwritable_data_directory_keeps_in_memory_matching(self):
        with patch.object(StarTools, "get_data_dir", side_effect=RuntimeError("permission denied")):
            plugin = DshBridgePlugin(None)
        plugin._remember_outbound("example-id")
        self.assertTrue(plugin._quoted_is_dsh_content(SimpleNamespace(id="example-id")))
