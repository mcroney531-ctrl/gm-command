"""
League Intel: a "Name" field per leaguemate, so chat can resolve "John".

Sleeper only knows display names (e.g. DylBagginses). The user can now type
the person's real name on each leaguemate's intel card. It is saved on the
device with the intel notes, shown on the card header, and given to the
assistant in the system prompt as: real name -> Sleeper username -> team.

Saving notes (a name or a new intel note) also rebuilds the system prompt, so
chat sees the change without waiting for the next Sleeper sync.

Stdlib only, offline: run with `python -m unittest discover -s tests`.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
BASELINE_INNERHTML_SINKS = 62


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


class NameFieldTest(unittest.TestCase):
    def test_intel_card_has_a_name_input(self):
        body = _function_body("renderIntel")
        self.assertIn('class="intel-input lm-name-input"', body)
        self.assertIn('id="name-${escapeAttr(lm.id)}"', body)
        self.assertIn('value="${escapeAttr(lm.realName)}"', body)
        self.assertIn("saveLmName(", body)
        self.assertIn(">Name<", body)

    def test_name_is_persisted_with_the_notes(self):
        # Since intel sync the name lives in the intel cache as a pending
        # server write; leaguemate.realName is derived from it.
        self.assertIn("e.name_pending = {", _function_body("saveLmName"))
        self.assertIn("intelPersist()", _function_body("lmSaveNotes"))
        self.assertIn("lm.realName = cleanRealName(v.realName)", _function_body("lmLoadNotes"))
        self.assertIn("realName: ''", _function_body("buildLeaguemates"))

    def test_save_cleans_input_and_updates_without_html(self):
        body = _function_body("saveLmName")
        self.assertIn("cleanRealName(", body)
        self.assertIn("lmSaveNotes()", body)
        self.assertIn("textContent", body)
        self.assertNotIn("innerHTML", body)
        clean = _function_body("cleanRealName")
        self.assertIn("slice(0, 40)", clean)
        self.assertIn(r"\s+", clean)

    def test_input_has_a_short_style(self):
        self.assertIn(".lm-name-input {", HTML)


class PromptTest(unittest.TestCase):
    def test_names_reach_the_system_prompt(self):
        body = _function_body("buildSystemPrompt")
        self.assertIn("lm.realName", body)
        self.assertIn("Sleeper username", body)
        self.assertIn("first name", body)

    def test_saving_notes_refreshes_the_prompt(self):
        self.assertIn("buildSystemPrompt()", _function_body("lmSaveNotes"))


class BaselineTest(unittest.TestCase):
    def test_no_new_html_sinks(self):
        self.assertEqual(len(re.findall(r"\.innerHTML\s*[+]?=", HTML)), BASELINE_INNERHTML_SINKS)


if __name__ == "__main__":
    unittest.main()
