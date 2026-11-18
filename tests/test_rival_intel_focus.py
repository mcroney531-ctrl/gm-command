"""
Rivals -> a team -> Intel -> Add/Edit Intel opens that team's intel only.

Before this, both buttons on the rival Intel tab called nav('intel'), which
rendered every leaguemate, collapsed, with a back button to Settings. Now they
call showRivalIntel(), which focuses the League Intel screen on the rival's
manager (one card, already open) and sends Back to that rival, re-rendering
its Intel tab so a note just added shows up there. Settings still opens the
full list.

Stdlib only, offline: run with `python -m unittest discover -s tests`.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")


def _function_body(name: str) -> str:
    match = re.search(r"(?:async\s+)?function\s+" + re.escape(name) + r"\s*\(", HTML)
    if not match:
        raise AssertionError(f"function {name} not found")
    depth, i = 0, HTML.index("{", match.end())
    for j in range(i, len(HTML)):
        depth += {"{": 1, "}": -1}.get(HTML[j], 0)
        if depth == 0:
            return HTML[i:j + 1]
    raise AssertionError(f"function {name} never closes")


class RivalIntelEntryTest(unittest.TestCase):
    def test_rival_intel_tab_opens_the_focused_view(self):
        body = _function_body("renderRdTab")
        intel = body[body.index("idx === 2"):body.index("const flagged")]
        self.assertNotIn("nav('intel')", intel)
        self.assertEqual(intel.count('onclick="showRivalIntel()"'), 2)

    def test_show_rival_intel_focuses_on_the_rivals_manager(self):
        body = _function_body("showRivalIntel")
        self.assertIn("currentRival", body)
        self.assertIn("intelId", body)
        self.assertIn("showIntel(", body)

    def test_settings_still_opens_the_full_list(self):
        self.assertIn('onclick="showIntel()"', HTML)
        self.assertIn("intelFocusId = focusId || null", _function_body("showIntel"))


class FocusedRenderTest(unittest.TestCase):
    def test_render_filters_to_the_focused_leaguemate_and_opens_it(self):
        body = _function_body("renderIntel")
        self.assertIn("intelFocusId", body)
        self.assertRegex(body, r"filter\(\s*(?:function\s*\(\s*l\s*\)|l\s*=>)")
        self.assertIn("open", body)

    def test_back_returns_to_the_rival_and_refreshes_its_tab(self):
        self.assertIn('onclick="intelBack()"', HTML)
        body = _function_body("intelBack")
        self.assertIn("nav('rival-detail')", body)
        self.assertIn("renderRdTab(currentRdTab)", body)
        self.assertIn("nav('settings')", body)


if __name__ == "__main__":
    unittest.main()
