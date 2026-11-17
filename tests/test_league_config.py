"""
D4: dynasty_config.json is GM Command's one source of league identity and
format, and index.html actually reads it.

Before D4 the JSON claimed to be canonical but nothing loaded it; index.html
hard-coded the league id, the Sleeper username, the team name and the league
format in constants, DOM text and two system prompts. Now the page fetches
the JSON once, validates it strictly, gates every league-scoped Sleeper call
and every chat prompt on it, binds DOM text with textContent, and shows a
"Config error" state instead of falling back to hard-coded identity.

Stdlib only, offline: run with `python -m unittest discover -s tests`.
The profile's values are checked against Ddreportcards by its
scripts/check_league_profile.py; these tests check shape and wiring.
The visual baseline (the single <style> block) and the count of HTML sinks
are pinned to the accepted 48fbc95 page so config binding can't quietly
become a redesign or a new injection point.
"""
import hashlib
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CONFIG_PATH = ROOT / "dynasty_config.json"

BASELINE_STYLE_SHA256_PREFIX = "ec4175b51e3fff76"   # 48fbc95
BASELINE_INNERHTML_SINKS = 62                        # 48fbc95

PROFILE_TYPES = {
    "league_id": str, "league_name": str, "my_team_name": str, "my_display_name": str,
    "num_teams": int, "num_qbs": int, "ppr": float, "scoring_label": str, "pass_td_pts": float,
    "is_dynasty": bool, "active_roster_size": int, "taxi_slots": int, "reserve_slots": int,
}
METADATA_KEYS = {"_note", "_schema"}


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


class ConfigFileTest(unittest.TestCase):
    def test_schema(self):
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(set(data) - METADATA_KEYS, set(PROFILE_TYPES))
        for key, kind in PROFILE_TYPES.items():
            with self.subTest(key):
                self.assertIs(type(data[key]), kind)
        self.assertRegex(data["league_id"], r"^\d{1,32}$")
        self.assertRegex(data["my_display_name"], r"^[A-Za-z0-9_.-]{1,40}$")
        self.assertNotIn("Mirrors config/dynasty_config.py in the Python engines.", data.get("_note", ""))


class NoHardcodedIdentityTest(unittest.TestCase):
    def test_identity_and_format_literals_are_gone(self):
        for literal in ("1312201057664786432", "TitansTrev55", "The Psych Ward", "Dynasty Daddies",
                        "12-team superflex", "All 12 rosters", "const LEAGUE_ID", "MY_USER_ID",
                        "const systemPrompt"):
            with self.subTest(literal):
                self.assertNotIn(literal, HTML)

    def test_stat_cells_are_bound_not_literal(self):
        # two rivals "Teams" cells + the home preview and chat opening notes
        self.assertEqual(len(re.findall(r'data-gm-config="num_teams"', HTML)), 4)
        self.assertEqual(len(re.findall(r'data-gm-config="format_short"', HTML)), 1)
        self.assertIn('data-gm-config="my_team_name"', HTML)
        self.assertIn('data-gm-config="my_display_name"', HTML)


class BootstrapGatingTest(unittest.TestCase):
    def test_config_is_fetched_once_strictly(self):
        self.assertEqual(len(re.findall(r"fetch\(\s*['\"]/dynasty_config\.json['\"]", HTML)), 1)
        loader = HTML[HTML.index("fetch('/dynasty_config.json'"):][:900]
        self.assertIn("content-type", loader)
        self.assertIn("validateGmConfig", loader)

    def test_validation_rejects_bad_shapes(self):
        body = _function_body("validateGmConfig")
        for needle in ("Array.isArray", "Number.isInteger", "typeof", "Object.freeze", r"^\d{1,32}$"):
            with self.subTest(needle):
                self.assertIn(needle, body)

    def test_sleeper_calls_wait_for_config_and_use_it(self):
        body = _function_body("loadSleeperData")
        gate = body.index("await requireGmConfig()")
        self.assertLess(gate, body.index("setLiveStatus('Syncing"))
        for url in ("/v1/user/' + encodeURIComponent(cfg.my_display_name)",
                    "/v1/league/' + encodeURIComponent(cfg.league_id) + '/rosters'",
                    "/v1/league/' + encodeURIComponent(cfg.league_id) + '/users'"):
            with self.subTest(url):
                self.assertGreater(body.index(url), gate)
        self.assertIn("setLiveStatus('Config error'", body)

    def test_chat_prompts_wait_for_config(self):
        for fn in ("sendChat", "runTradeFinder"):
            body = _function_body(fn)
            with self.subTest(fn):
                self.assertIn("await chatSystemPrompt()", body)
                self.assertLess(body.index("await chatSystemPrompt()"), body.index("callChatAPI("))
                self.assertNotIn("|| systemPrompt", body)

    def test_prompts_and_dom_come_from_config(self):
        self.assertIn("cfg.my_team_name", _function_body("fallbackSystemPrompt"))
        self.assertIn("GM_CONFIG.my_team_name", _function_body("buildSystemPrompt"))
        apply = _function_body("applyGmConfigToDom")
        self.assertIn("textContent", apply)
        self.assertNotIn("innerHTML", apply)

    def test_failure_is_visible_and_has_no_fallback_identity(self):
        self.assertIn("'Config error'", _function_body("showGmConfigError"))
        self.assertIn("throw new Error(GM_CONFIG_UNAVAILABLE_MSG)", _function_body("requireGmConfig"))


class ServiceWorkerTest(unittest.TestCase):
    def test_config_is_precached_with_the_page(self):
        sw = (ROOT / "sw.js").read_text(encoding="utf-8")
        self.assertIn("'/dynasty_config.json'", sw)
        self.assertNotIn("'gm-command-v1'", sw)


class VisualAndSecurityBaselineTest(unittest.TestCase):
    def test_style_block_is_unchanged(self):
        styles = re.findall(r"<style[^>]*>([\s\S]*?)</style>", HTML)
        self.assertEqual(len(styles), 1)
        self.assertTrue(hashlib.sha256(styles[0].encode()).hexdigest().startswith(BASELINE_STYLE_SHA256_PREFIX))

    def test_no_new_html_sinks(self):
        self.assertEqual(len(re.findall(r"\.innerHTML\s*[+]?=", HTML)), BASELINE_INNERHTML_SINKS)
        self.assertEqual(HTML.count("insertAdjacentHTML"), 0)
        self.assertEqual(len(re.findall(r"\.outerHTML\s*=", HTML)), 1)


if __name__ == "__main__":
    unittest.main()
