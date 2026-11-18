"""
Settings and League Intel are styled, scrollable, and collapse correctly.

Every class these two screens use had no CSS rule from the page's first
commit, so they rendered as raw dark text on navy, the intel cards were stuck
open with their Synthesizing / Breakdown-updated rows showing, and the intel
list couldn't scroll (.screen hides overflow and nothing inside scrolled).
These checks make sure no class on either screen is left without a rule
again, and pin the behaviors the markup and addIntel() depend on.

Stdlib only, offline: python -m unittest discover -s tests
"""
import pathlib
import re
import unittest

HTML = (pathlib.Path(__file__).resolve().parent.parent / "index.html").read_text(encoding="utf-8")
CSS = "\n".join(re.findall(r"<style[^>]*>([\s\S]*?)</style>", HTML))


def _between(start, end):
    a = HTML.index(start)
    return HTML[a:HTML.index(end, a)]


def _classes(fragment):
    names = set()
    for attr in re.findall(r'class="([^"]*)"', fragment):
        attr = re.sub(r"\$\{[^}]*\}", " ", attr)
        names.update(attr.split())
    return names


def _rule(selector):
    match = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", CSS)
    return match.group(1) if match else None


class EveryClassIsStyledTest(unittest.TestCase):
    def test_settings_screen(self):
        fragment = _between('id="screen-settings"', 'id="screen-intel"')
        for name in sorted(_classes(fragment)):
            with self.subTest(name):
                self.assertRegex(CSS, r"\." + re.escape(name) + r"(?![\w-])")

    def test_league_intel_screen_and_cards(self):
        fragment = _between('id="screen-intel"', "</div>\n\n<script>") + _between("function renderIntel()", "function toggleLMCard")
        for name in sorted(_classes(fragment)):
            with self.subTest(name):
                self.assertRegex(CSS, r"\." + re.escape(name) + r"(?![\w-])")


class BehaviorTest(unittest.TestCase):
    def test_scroll_container_scrolls(self):
        rule = _rule(".settings-scroll")
        self.assertIn("overflow-y: auto", rule)
        self.assertIn("flex: 1", rule)

    def test_cards_start_closed_and_open_on_toggle(self):
        self.assertIn("display: none", _rule(".lm-body"))
        self.assertIn("display: flex", _rule(".lm-card.open .lm-body"))
        self.assertIn("rotate(180deg)", _rule(".lm-card.open .chevron"))

    def test_status_rows_hidden_until_add_intel_shows_them(self):
        self.assertIn("display: none", _rule(".synth-row, .success-row"))
        self.assertIn("synth.style.display = 'flex'", HTML)
        self.assertIn("succ.style.display = 'flex'", HTML)

    def test_add_intel_states(self):
        self.assertIsNotNone(_rule(".add-intel-btn:disabled"))
        self.assertIsNotNone(_rule(".blurb-display.empty"))
        self.assertIsNotNone(_rule(".blurb-display.blurb-hl"))


if __name__ == "__main__":
    unittest.main()
