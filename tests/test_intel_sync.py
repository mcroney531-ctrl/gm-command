"""
League Intel sync (Batch 2): structural guarantees in index.html and sw.js.

Behaviour is exercised end to end, against the real Report Cards backend, by
tests/e2e/intel_sync_e2e.js (see tests/e2e/README.md). These stdlib checks pin
the properties that must not quietly regress:

* only the production origin sends writes, and PUT exists in one place;
* only a complete 200 snapshot is merged; 401/503/network failures merge
  nothing, and merging never deletes local data;
* conflicts are decided by server revisions; device clocks never are;
* the legacy localStorage notes are read, never deleted;
* the service worker never caches the backend, so an offline load cannot
  replay a stale /intel as if it were live;
* no new HTML sinks; imported and server text reaches the DOM escaped.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
SW = (ROOT / "sw.js").read_text(encoding="utf-8")


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


class WritesTest(unittest.TestCase):
    def test_production_origin_constant(self):
        self.assertIn("const INTEL_PROD_ORIGIN = 'https://gm-command.netlify.app';", HTML)
        self.assertEqual(_function_body("intelWritable").strip(),
                         "{ return location.origin === INTEL_PROD_ORIGIN; }")

    def test_put_is_sent_from_one_function_only(self):
        self.assertEqual(len(re.findall(r"method:\s*'PUT'", HTML)), 1)
        self.assertIn("method: 'PUT'", _function_body("intelPut"))

    def test_pushes_happen_only_after_the_writable_check(self):
        body = _function_body("intelSyncOnce")
        self.assertLess(body.index("if (!intelWritable())"), body.index("intelPushOwner("))
        self.assertEqual(HTML.count("intelPushOwner("), 2)   # definition + the one call

    def test_import_is_production_only(self):
        self.assertIn("if (!intelWritable())", _function_body("intelPickImport"))


class ReadAndMergeTest(unittest.TestCase):
    def test_only_a_complete_200_is_merged(self):
        body = _function_body("intelSyncOnce")
        merge = body.index("intelMerge(data)")
        for gate in ("res.status === 401", "if (!res.ok) return intelRetryLater()", "data.schema !== 1"):
            with self.subTest(gate):
                self.assertLess(body.index(gate), merge)

    def test_merge_never_deletes_or_blanks_local_notes(self):
        body = _function_body("intelMerge")
        self.assertNotIn("delete ", body)
        self.assertNotIn("= {}", body)
        self.assertIn("if (!l) e.obs[o.id] =", body)          # adds what we lack
        self.assertIn(".rev = 0", body)                        # re-sends what the server lost

    def test_no_device_clock_in_conflict_decisions(self):
        for fn in ("intelMerge", "intelPushOwner", "intelSynthesize", "saveLmName", "intelApplyImport", "intelApplyLegacy"):
            with self.subTest(fn):
                self.assertNotIn("Date.now", _function_body(fn))

    def test_name_and_breakdown_writes_carry_base_rev(self):
        body = _function_body("intelPushOwner")
        self.assertIn("{ value: p.value, base_rev: p.base_rev }", body)
        self.assertIn("{ value: b.value, base_rev: b.base_rev, covers: covers }", body)

    def test_rejected_name_is_kept_for_restore(self):
        self.assertIn("e.name_rejected = { value: p.value }", _function_body("intelPushOwner"))
        self.assertIn("e.name_pending = { value: e.name_rejected.value", _function_body("intelUseRejectedName"))


class SourceDataTest(unittest.TestCase):
    def test_note_is_stored_before_synthesis(self):
        body = _function_body("addIntel")
        self.assertLess(body.index("e.obs[obsId] ="), body.index("intelSynthesize("))
        self.assertLess(body.index("lmSaveNotes()"), body.index("intelSynthesize("))

    def test_stale_synthesis_is_not_applied(self):
        body = _function_body("intelSynthesize")
        self.assertIn("return 'stale'", body)
        self.assertLess(body.index("return 'stale'"), body.index("e.breakdown_pending = {"))
        self.assertNotIn("delete", body)

    def test_new_notes_use_random_ids_and_legacy_uses_namespaced_hashes(self):
        self.assertIn("const obsId = intelNewId();", _function_body("addIntel"))
        self.assertIn("crypto.randomUUID", _function_body("intelNewId"))
        legacy = _function_body("intelLegacyId")
        self.assertIn("INTEL_LEGACY_NS", legacy)
        self.assertIn("SHA-256", legacy)

    def test_legacy_store_is_read_but_never_deleted(self):
        self.assertIn("localStorage.getItem(INTEL_LEGACY_KEY)", _function_body("intelImportLegacy"))
        self.assertNotRegex(HTML, r"removeItem\(\s*(INTEL_LEGACY_KEY|'gmc_leaguemate_notes')")
        self.assertNotRegex(HTML, r"setItem\(\s*(INTEL_LEGACY_KEY|'gmc_leaguemate_notes')")

    def test_migration_only_fills_never_set_fields(self):
        body = _function_body("intelApplyLegacy")
        self.assertIn("if (name && !e.name && !e.name_pending) e.name_pending = { value: name, base_rev: 0 };", body)
        self.assertIn("if (blurb && !e.breakdown && !e.breakdown_pending)", body)


class NoSilentLossTest(unittest.TestCase):
    """Every path that removes a local value keeps it somewhere visible."""

    def test_unreadable_cache_is_preserved_before_replacement(self):
        body = _function_body("intelLoadCache")
        self.assertIn("INTEL_CACHE_KEY + '_unreadable_'", body)
        self.assertLess(body.index("_unreadable_"), body.rindex("return intelEmptyCache()"))

    def test_storage_failure_is_surfaced(self):
        self.assertIn("intelSync.storageError = true", _function_body("intelPersist"))
        self.assertIn("if (intelSync.storageError)", _function_body("intelStatusText"))

    def test_losing_breakdown_is_kept_and_restorable(self):
        push = _function_body("intelPushOwner")
        self.assertIn("e.breakdown_rejected = { value: b.value, covers: covers.slice() }", push)
        self.assertLess(push.index("e.breakdown_rejected = {"), push.index("e.breakdown_pending = null;\n        }"))
        self.assertIn("e.breakdown_pending = { value: r.value", _function_body("intelUseRejectedBreakdown"))
        self.assertIn("intelUseRejectedBreakdown(", _function_body("renderIntel"))

    def test_rejected_values_are_exported(self):
        body = _function_body("intelExport")
        self.assertIn("rejected_name:", body)
        self.assertIn("rejected_breakdown:", body)

    def test_invalid_name_keeps_value_with_accurate_reason(self):
        self.assertIn("e.name_rejected = { value: p.value, reason: 'invalid' }", _function_body("intelPushOwner"))
        self.assertIn("the server rejected it", _function_body("renderIntel"))


class ServiceWorkerTest(unittest.TestCase):
    def test_backend_is_network_only(self):
        bypass = SW[SW.index("self.addEventListener('fetch'"):SW.index("event.respondWith(fetch(event.request));")]
        self.assertIn("ddreportcards.onrender.com", bypass)
        self.assertIn("gm-command-v3", SW)


class RenderingTest(unittest.TestCase):
    def test_new_intel_text_is_escaped(self):
        body = _function_body("renderIntel")
        self.assertIn("escapeHtml(lm.nameRejected.value)", body)
        self.assertIn("escapeHtml(e.text)", body)

    def test_import_summary_is_plain_text(self):
        body = _function_body("intelImportFile")
        self.assertIn("window.alert(summary)", body)
        self.assertNotIn("innerHTML", body + _function_body("intelApplyImport"))


if __name__ == "__main__":
    unittest.main()
