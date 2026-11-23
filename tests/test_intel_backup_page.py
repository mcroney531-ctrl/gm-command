"""
intel-backup.html: a one-time, read-only backup of the pre-sync League Intel
(localStorage "gmc_leaguemate_notes"), deployed before the sync update so it
can read the phone's existing data on the production origin.

It must never write or clear storage, never include the access key and load
nothing external. Its output format is accepted by the updated app's Import.
End to end (backup -> verify -> restore after a wipe): tests/e2e.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = (ROOT / "intel-backup.html").read_text(encoding="utf-8")


class BackupPageTest(unittest.TestCase):
    def test_reads_only_the_legacy_key(self):
        self.assertIn("var KEY = 'gmc_leaguemate_notes';", PAGE)
        self.assertIn("localStorage.getItem(KEY)", PAGE)
        for forbidden in ("setItem", "removeItem", ".clear(", "indexedDB", "gmCommandAccessKey", "sessionStorage"):
            with self.subTest(forbidden):
                self.assertNotIn(forbidden, PAGE)

    def test_loads_nothing_external(self):
        self.assertIsNone(re.search(r"<script[^>]+src=", PAGE))
        self.assertIsNone(re.search(r"<link[^>]+href=", PAGE))
        self.assertNotIn("fetch(", PAGE)
        self.assertNotIn("XMLHttpRequest", PAGE)

    def test_no_html_sinks(self):
        self.assertNotIn("innerHTML", PAGE)
        self.assertNotIn("document.write", PAGE)

    def test_declares_its_file_format(self):
        # The app's Import accepts this format: see test_intel_sync.py.
        self.assertIn("format: 'gm-command-legacy-backup', version: 1", PAGE)

    def test_not_indexed(self):
        self.assertIn('<meta name="robots" content="noindex">', PAGE)


if __name__ == "__main__":
    unittest.main()
