"""Unit tests for the metric semantic-layer compiler (metrics.compile_spec).

Pure-Python — no DB or server needed. Run directly:

    python tests/backend/test_metric_compiler.py

These assert the SAFETY invariants, which are the whole point of the design:
no raw rows, key validation, parameterized values, k-anonymity, bounded cost.
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import metrics


def expect_error(spec, msg):
    try:
        metrics.compile_spec(spec)
    except metrics.SpecError:
        return
    raise AssertionError(f"expected SpecError for: {msg}")


def test_no_measure_rejected():
    # No raw rows ever — a spec with no measure must fail.
    expect_error({"dataset": "messages", "dimensions": ["day"]}, "no measure")
    expect_error({"dataset": "messages", "dimensions": ["day"], "measures": []}, "empty measures")


def test_unknown_keys_rejected():
    expect_error({"dataset": "nope", "measures": ["count"]}, "unknown dataset")
    expect_error({"dataset": "messages", "measures": ["evil"]}, "unknown measure")
    expect_error({"dataset": "messages", "dimensions": ["ssn"], "measures": ["count"]}, "unknown dimension")
    expect_error({"dataset": "messages", "measures": ["count"],
                  "filters": [{"field": "secret", "op": "eq", "value": 1}]}, "unknown filter")
    expect_error({"dataset": "messages", "measures": ["count"],
                  "order": [{"by": "nope"}]}, "unknown order field")


def test_filter_op_must_be_allowed():
    # `since` allows gte/lt/last_days, not eq.
    expect_error({"dataset": "messages", "measures": ["count"],
                  "filters": [{"field": "since", "op": "eq", "value": 1}]}, "disallowed op")


def test_too_many_dimensions():
    expect_error({"dataset": "calls", "dimensions": ["type", "mode", "day", "type"],
                  "measures": ["count"]}, "dimension cap")


def test_basic_group_by_compiles():
    sql, params, cols, aliases = metrics.compile_spec(
        {"dataset": "messages", "dimensions": ["day"], "measures": ["count"]})
    assert "FROM analytics_messages" in sql
    assert "GROUP BY 1" in sql
    assert aliases == ["d0", "m0"]
    assert [c["name"] for c in cols] == ["Day", "Messages"]
    assert params == []


def test_values_are_parameterized():
    # The value must NOT appear inline in the SQL — it goes to params as %s.
    sql, params, _, _ = metrics.compile_spec(
        {"dataset": "messages", "dimensions": ["day"], "measures": ["count"],
         "filters": [{"field": "since", "op": "last_days", "value": 7}]})
    assert "%s" in sql
    assert params == [7]
    assert "7" not in sql.replace("%s", "")  # no inline literal


def test_injection_value_is_not_interpolated():
    evil = "1); DROP TABLE message;--"
    sql, params, _, _ = metrics.compile_spec(
        {"dataset": "servers", "dimensions": ["server"], "measures": ["members"],
         "filters": [{"field": "since", "op": "gte", "value": evil}]
         if "since" in metrics.DATASETS["servers"].filters else []})
    # servers has no `since`; use messages to actually carry a value
    sql, params, _, _ = metrics.compile_spec(
        {"dataset": "messages", "measures": ["count"],
         "filters": [{"field": "since", "op": "gte", "value": evil}]})
    assert evil not in sql           # never interpolated
    assert params == [evil]          # carried as a bind param


def test_k_anonymity_applied_only_for_sensitive_dim():
    # Grouping users by `faction` (sensitive) must suppress small groups.
    sql, _, _, _ = metrics.compile_spec(
        {"dataset": "users", "dimensions": ["faction"], "measures": ["count"]})
    assert "HAVING count(*) >= 5" in sql
    # Grouping by `day` (not sensitive) must NOT suppress.
    sql2, _, _, _ = metrics.compile_spec(
        {"dataset": "users", "dimensions": ["day"], "measures": ["count"]})
    assert "HAVING" not in sql2


def test_bad_last_days_raises_specerror():
    # Must be SpecError (not a raw ValueError) so callers' handling works.
    expect_error({"dataset": "messages", "measures": ["count"],
                  "filters": [{"field": "since", "op": "last_days", "value": "abc"}]},
                 "non-int last_days")


def test_limit_is_capped():
    sql, _, _, _ = metrics.compile_spec(
        {"dataset": "messages", "dimensions": ["day"], "measures": ["count"], "limit": 999999})
    assert f"LIMIT {metrics.MAX_LIMIT}" in sql


def test_presets_all_validate():
    for key, preset in metrics.METRIC_PRESETS.items():
        metrics.validate_spec(preset["spec"])  # SQL or provider — must not raise


def test_describe_datasets_has_no_pii_terms():
    blob = str(metrics.describe_datasets()).lower()
    for bad in ("password", "email", "token", "dkim"):
        assert bad not in blob


def test_provider_dataset_validates_without_measures():
    # Provider datasets need no measures (compile_spec would reject; validate_spec ok).
    metrics.validate_spec({"dataset": "system_resources"})
    expect_error({"dataset": "system_resources"}, "provider via compile_spec")  # compile still rejects


def test_provider_dataset_runs():
    class FakeSrv:
        path = "."
        class db:
            @staticmethod
            def _do(fn):
                class C:
                    def execute(self, *a, **k): return self
                    def fetchone(self): return {"s": 1048576, "c": 0}
                return fn(C())
    out = metrics.run_spec(FakeSrv(), {"dataset": "storage"})
    assert out["columns"][0]["name"] == "Metric"
    assert len(out["rows"]) >= 1


def run():
    """Entry point for `vesta test`: [(label, ok)]."""
    results = []
    for name, t in sorted(globals().items()):
        if not name.startswith("test_"):
            continue
        try:
            t()
            results.append((name, True))
        except Exception as e:
            results.append((f"{name} — {e}", False))
    return results


if __name__ == "__main__":
    results = run()
    for label, ok in results:
        print(f"  {'ok  ' if ok else 'FAIL'} {label}")
    passed = sum(ok for _, ok in results)
    print(f"\n{passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)
