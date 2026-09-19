"""Paired trial provenance, deterministic outcome deltas and conservative unknowns."""
from copy import deepcopy
from pathlib import Path

import pytest

from agent_memory.contracts_cli import execute_request as plan_api
from agent_memory.contracts_store import ContractError
from agent_memory.policy import PolicyStore, content_revision
from agent_memory.rsi import execute_request
from agent_memory.rsi_store import RSIStore, render_artifact
from agent_memory.rsi_trial_stats import summarize
from .test_rsi import context, make_plan, propose

ENVIRONMENT = {"agent_model": "fixed-synthetic-model", "tool_environment": "tools-test-v1", "max_tokens": 10000, "max_steps": 100}


@pytest.fixture
def api(tmp_path):
    return lambda request: execute_request(request, tmp_path, no_git=True)


def spec_request(proposal, trial_id="trial", cases=None):
    return {"action": "trial_spec", "trial_id": trial_id, "proposal_id": proposal["id"],
            "hypothesis": "Candidate improves independently checked task correctness without unsafe behavior.",
            "procedure": "Use fixed synthetic cases and the same declared model/tool budget for both arms.",
            "stopping_rule": "Stop unsafe execution and record missing measurements, never count them as success.",
            "environment": deepcopy(ENVIRONMENT),
            "metrics": {"outcome": "Independent deterministic task check passes", "safety": "Count boundary violations", "cost_unit": "tokens"},
            "cases": cases if cases is not None else [{"case_id": split, "revision": content_revision(split), "split": split, "family": split} for split in ("development", "holdout", "control")]}


def register(api, **kwargs):
    return api(spec_request(propose(api), **kwargs))["artifact"]


def arm(outcome=False, safety=0, cost=10, status="observed"):
    return {"status": status, "outcome": outcome if status == "observed" else None,
            "safety_violations": safety if status == "observed" else None, "cost": cost if status == "observed" else None,
            "environment": deepcopy(ENVIRONMENT) if status == "observed" else None,
            "evidence_refs": ["synthetic/not-a-file#reported-measurement"] if status == "observed" else [],
            "note": "Synthetic caller-reported fixture, not a verified experiment."}


def pair(case_id="holdout", baseline=None, candidate=None):
    return {"case_id": case_id, "baseline": baseline or arm(False), "candidate": candidate or arm(True)}


def results_request(trial, results=None):
    return {"action": "trial_results", "trial_id": trial["id"], "trial_revision": trial["revision"],
            "results": results if results is not None else [pair(case["case_id"]) for case in trial["data"]["protocol"]["cases"]],
            "review_note": "Caller-selected review context, never authenticated independent proof."}


def test_protocol_precedes_exact_immutable_result_and_changes_no_policy(api, tmp_path):
    proposal = propose(api)
    original = context(api)["policy"]
    trial = api(spec_request(proposal))["artifact"]
    assert trial["kind"] == "trial-spec"
    assert trial["bindings"]["artifacts"] == [{"id": proposal["id"], "revision": proposal["revision"]}]
    assert trial["data"]["baseline_revision"] == proposal["bindings"]["policy_revision"]
    assert trial["data"]["candidate_revision"] == proposal["data"]["body_hash"]
    result = api(results_request(trial))
    outcome = result["artifact"]
    assert outcome["kind"] == "trial-results"
    assert outcome["bindings"]["artifacts"] == [{"id": trial["id"], "revision": trial["revision"]}]
    assert outcome["data"]["protocol"] == trial["data"]["protocol"]
    assert outcome["data"]["status"] == "reported"
    assert outcome["data"]["summary"]["total"]["outcome"]["delta_rate"] == 1
    assert outcome["data"]["summary"]["verified_improvement"] is False
    assert outcome["data"]["summary"]["automatic_promotion"] is False
    assert outcome["freshness"]["lineage"]["status"] == "current"
    assert outcome["freshness"]["lineage"]["artifacts_checked"] == 2
    assert result["persistence"]["git"]["status"] == "disabled"
    assert context(api)["policy"] == original
    assert not PolicyStore(tmp_path).path().exists()
    with pytest.raises(ContractError, match="immutable"):
        api(results_request(trial))
    with pytest.raises(ContractError, match="immutable"):
        api(spec_request(proposal))


def test_results_require_a_registered_exact_trial_not_a_proposal(api):
    proposal = propose(api)
    with pytest.raises(ContractError, match="registered trial-spec"):
        api(results_request(proposal, []))
    missing = {**proposal, "id": "missing-trial"}
    with pytest.raises(ContractError, match="not found"):
        api(results_request(missing, []))
    trial = api(spec_request(proposal))["artifact"]
    request = results_request(trial)
    request["trial_revision"] = content_revision("wrong trial bytes")
    with pytest.raises(ContractError, match="stale trial"):
        api(request)


@pytest.mark.parametrize("kind", ["trial-spec", "trial-results"])
def test_generic_record_cannot_bypass_protocol_validation(api, kind):
    proposal = propose(api)
    with pytest.raises(ContractError, match="generic record"):
        api({"action": "record", "kind": kind, "bindings": proposal["bindings"], "data": {"status": "assessed"}})


def test_outcome_safety_and_cost_are_separate_and_adverse_splits_survive(api):
    trial = register(api)
    results = [pair("development", arm(False, 0, 100), arm(True, 0, 1)),
               pair("holdout", arm(True, 0, 3), arm(False, 2, 5)),
               pair("control", arm(True, 0, 2), arm(False, 0, 1))]
    summary = api(results_request(trial, results))["artifact"]["data"]["summary"]
    assert summary["total"]["outcome"]["delta_successes"] == -1
    assert summary["total"]["cost"]["delta_total"] == -98
    assert summary["total"]["cost"]["regressed_pairs"] == 1
    assert summary["total"]["safety"]["delta_violations"] == 2
    assert summary["total"]["safety"]["regressed_pairs"] == 1
    assert summary["splits"]["holdout"]["outcome"]["losses"] == 1
    assert summary["splits"]["control"]["outcome"]["losses"] == 1
    assert {"safety-regression", "candidate-boundary-violations", "cost-regression", "holdout-regression", "control-regression"} <= set(summary["limitations"])
    assert "reward" not in summary and summary["automatic_promotion"] is False


def test_empty_and_unknown_results_never_imply_pass_or_safety(api):
    trial = register(api)
    data = api(results_request(trial, []))["artifact"]["data"]
    summary = data["summary"]
    assert summary["total"]["outcome"]["paired"] == 0
    assert summary["total"]["outcome"]["delta_rate"] is None
    assert summary["total"]["outcome"]["missing_or_unknown"] == 3
    assert summary["total"]["arm_statuses"] == {"observed": 0, "missing": 6, "invalid": 0}
    assert summary["unreported_cases"] == ["development", "holdout", "control"]
    assert {"no-observed-pairs", "no-heldout-pairs", "no-control-pairs", "unknown-safety", "unknown-cost"} <= set(summary["limitations"])
    assert any("not necessarily actual execution" in note for note in data["limitations"])
    assert any("not attestations" in note for note in data["limitations"])


def test_partial_metrics_and_invalid_arms_use_per_metric_denominators(api):
    trial = register(api)
    results = [pair("development", arm(None, None, None), arm(True, 1, 4)),
               pair("holdout", arm(status="missing"), arm(status="invalid"))]
    summary = api(results_request(trial, results))["artifact"]["data"]["summary"]
    assert summary["total"]["outcome"]["paired"] == 0
    assert summary["total"]["safety"]["known_candidate_violations"] == 1
    assert summary["total"]["safety"]["paired"] == 0
    assert summary["total"]["cost"]["mean_delta"] is None
    assert summary["total"]["arm_statuses"] == {"observed": 2, "missing": 3, "invalid": 1}
    assert summary["unreported_cases"] == ["control"]
    assert "candidate-boundary-violations" in summary["limitations"]


def test_replicates_and_cross_split_families_cannot_claim_independence(api):
    cases = [{"case_id": f"case-{i}", "revision": content_revision("same exact fixture"), "split": split, "family": "same-task"}
             for i, split in enumerate(("development", "holdout", "control"))]
    trial = register(api, cases=cases)
    summary = api(results_request(trial))["artifact"]["data"]["summary"]
    assert summary["total"]["source_families"] == 1
    assert summary["cross_split_families"] == [{"family": "same-task", "splits": ["control", "development", "holdout"]}]
    assert {"single-source-family", "cross-split-family-overlap"} <= set(summary["limitations"])


@pytest.mark.parametrize("field,value", [("agent_model", "other-model"), ("tool_environment", "other-tools"), ("max_tokens", 9000), ("max_steps", 99)])
def test_mismatched_model_tools_or_budgets_do_not_count_as_comparable(api, field, value):
    trial = register(api)
    request = results_request(trial)
    request["results"][0]["candidate"]["environment"][field] = value
    with pytest.raises(ContractError, match="differ from protocol"):
        api(request)


@pytest.mark.parametrize("key,value", [("outcome", 1), ("outcome", "success"), ("safety_violations", True),
                                     ("safety_violations", -1), ("safety_violations", .5), ("cost", True),
                                     ("cost", -1), ("cost", float("nan")), ("cost", float("inf")),
                                     ("cost", 1e10), ("evidence_refs", [])])
def test_invalid_or_unreferenced_observed_measurements_rejected(api, key, value):
    trial = register(api)
    request = results_request(trial)
    request["results"][0]["baseline"][key] = value
    with pytest.raises(ContractError):
        api(request)


@pytest.mark.parametrize("status", ["missing", "invalid"])
def test_unobserved_arms_cannot_smuggle_favorable_measurements(api, status):
    trial = register(api)
    request = results_request(trial, [pair(baseline=arm(status=status))])
    request["results"][0]["baseline"]["outcome"] = True
    with pytest.raises(ContractError, match="null measurements"):
        api(request)


@pytest.mark.parametrize("mutation", [
    lambda request: request["cases"].append(deepcopy(request["cases"][0])),
    lambda request: request["cases"].clear(),
    lambda request: request["cases"][0].update(split="test-after-seeing-outcome"),
    lambda request: request["cases"][1].update(revision=request["cases"][0]["revision"]),
    lambda request: request["environment"].update(max_tokens=True),
    lambda request: request.update(results=[]),
    lambda request: request["metrics"].update(cost_unit="assessor_score"),
])
def test_invalid_or_posthoc_protocol_shapes_rejected(api, mutation):
    request = spec_request(propose(api))
    mutation(request)
    with pytest.raises(ContractError):
        api(request)


def test_duplicate_undeclared_case_and_result_protocol_overrides_rejected(api):
    trial = register(api)
    for rows in ([pair(), pair()], [pair("not-registered")]):
        with pytest.raises(ContractError, match="undeclared or duplicate"):
            api(results_request(trial, rows))
    request = results_request(trial)
    request["metrics"] = trial["data"]["protocol"]["metrics"]
    with pytest.raises(ContractError, match="unknown"):
        api(request)


def test_cost_delta_does_not_accumulate_binary_rounding_regressions(api):
    trial = register(api)
    results = [pair("development", arm(cost=.1), arm(cost=.3)), pair("holdout", arm(cost=.2), arm(cost=0))]
    summary = api(results_request(trial, results))["artifact"]["data"]["summary"]
    assert summary["total"]["cost"]["baseline_total"] == .3
    assert summary["total"]["cost"]["delta_total"] == 0
    assert summary["total"]["cost"]["regressed_pairs"] == 1


def test_stale_plan_or_policy_prevents_trial_results_with_current_lineage_intact(api, tmp_path):
    plan = make_plan(tmp_path)
    proposal = propose(api, ["example"])
    trial = api(spec_request(proposal))["artifact"]
    plan_api({"action": "update", "plan_id": "example", "revision": plan["revision"], "work_item_id": "work", "status": "in_progress"}, tmp_path, no_git=True)
    with pytest.raises(ContractError, match="lineage"):
        api(results_request(trial))
    assert api({"action": "read", "id": trial["id"]})["artifact"]["freshness"]["stale"]
    policy = PolicyStore(tmp_path)
    policy.execute({"action": "update", "body": "Changed policy", "expected_revision": trial["bindings"]["policy_revision"], "actor": "human", "reason": "Synthetic policy mutation"}, no_git=True)
    with pytest.raises(ContractError, match="stale trial policy"):
        api(results_request(trial))


def test_result_summary_is_replayed_on_read_including_numeric_types(api, tmp_path):
    trial = register(api)
    result = api(results_request(trial))["artifact"]
    store = RSIStore(tmp_path, no_git=True)
    value = store.read(result["id"])
    value["data"]["summary"]["splits"]["holdout"]["outcome"]["paired"] = True
    # Simulate a fully rerendered corrupted file, not merely a stale checksum.
    Path(result["path"]).write_text(render_artifact(value))
    with pytest.raises(ContractError, match="integrity"):
        api({"action": "read", "id": result["id"]})


def test_no_evidence_reference_is_dereferenced_and_result_is_not_an_evaluation(api):
    trial = register(api)
    request = results_request(trial)
    request["results"][0]["baseline"]["evidence_refs"] = ["/private/does-not-exist/synthetic.json"]
    result = api(request)["artifact"]
    assert result["data"]["results"][0]["baseline"]["evidence_refs"] == ["/private/does-not-exist/synthetic.json"]
    with pytest.raises(ContractError, match="evaluation must bind"):
        api({"action": "promote", "proposal_id": trial["data"]["proposal"]["id"], "evaluation_id": result["id"],
             "expected_revision": trial["bindings"]["policy_revision"], "review_note": "Not approval", "actor": "agent", "apply": True})


def test_pure_summary_does_not_mutate_inputs(api):
    trial = register(api)
    protocol = trial["data"]["protocol"]
    rows = results_request(trial)["results"]
    before = deepcopy((protocol, rows))
    assert summarize(protocol, rows) == summarize(protocol, rows)
    assert (protocol, rows) == before
