"""Immutable declared paired protocols and outcome reports; no experiment runner.

A protocol is registered before its result RECORD is accepted. Caller chronology,
case/model/environment identities and evidence references are not attestations.
Callers hold contracts -> policy locks; all reachable current lineage remains
required. No policy update, score threshold, automatic credit or network occurs.
"""
from __future__ import annotations

from copy import deepcopy
import math

from agent_memory.contracts_store import ContractError, identifier, now, shape
from agent_memory.rsi_lineage import require_lineage
from agent_memory.rsi_schema import artifact_refs, artifact_revision, data_object, json_text, revision, string
from agent_memory.rsi_trial_stats import SPLITS, summarize

SCHEMA = "memory-rsi-trial/1"
TRIAL_KINDS = ("trial-spec", "trial-results")
MAX_CASES = 64
MAX_NUMBER = 1_000_000_000
PROTOCOL_FIELDS = ("hypothesis", "procedure", "stopping_rule", "environment", "metrics", "cases")
LIMITATIONS = [
    "Registration precedes result recording, not necessarily actual execution; caller chronology is not verified preregistration.",
    "Case digests, environment identifiers, measurements, evidence references and reviewer notes are caller reports, not attestations. Referenced files are never read.",
    "The fixed manifest exposes omissions and split overlap but does not prove randomization, blinding, lack of contamination, independence or causal improvement.",
    "One immutable result report per protocol; adverse and missing measurements are retained. Additional trials require a new declared protocol, not overwritten outcomes.",
    "Useful-outcome, safety and cost differences remain separate; none grants permissions, earns achievement or automatically promotes policy.",
]


def _integer(value, label, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_NUMBER:
        raise ContractError(f"{label} must be an integer in {minimum}..{MAX_NUMBER}")


def _environment(value):
    shape(value, ("agent_model", "tool_environment", "max_tokens", "max_steps"), label="trial environment")
    for key in ("agent_model", "tool_environment"):
        string(value[key], key, 256)
    for key in ("max_tokens", "max_steps"):
        _integer(value[key], key, 1)
    return value


def validate_protocol(value):
    shape(value, PROTOCOL_FIELDS, label="trial protocol")
    for key in ("hypothesis", "procedure", "stopping_rule"):
        string(value[key], key, 4096)
    _environment(value["environment"])
    metrics = shape(value["metrics"], ("outcome", "safety", "cost_unit"), label="trial metrics")
    for key in ("outcome", "safety"):
        string(metrics[key], key, 2048)
    if metrics["cost_unit"] not in ("tokens", "milliseconds", "usd", "units"):
        raise ContractError("unsupported trial cost unit")
    cases = value["cases"]
    if not isinstance(cases, list) or not 1 <= len(cases) <= MAX_CASES:
        raise ContractError(f"trial cases must contain 1..{MAX_CASES} paired units")
    ids, families = set(), {}
    for case in cases:
        shape(case, ("case_id", "revision", "split", "family"), label="trial case")
        case_id = identifier(case["case_id"], "case_id")
        if case_id in ids:
            raise ContractError("duplicate trial case_id")
        ids.add(case_id)
        revision(case["revision"], policy=True)
        identifier(case["family"], "case family")
        if case["split"] not in SPLITS:
            raise ContractError("trial case split must be development, holdout or control")
        # Renaming a repeated exact case cannot create a new independent family.
        prior = families.setdefault(case["revision"], case["family"])
        if prior != case["family"]:
            raise ContractError("identical trial case revisions must share one source family")
    data_object(value)
    return value


def _arm(value, environment):
    shape(value, ("status", "outcome", "safety_violations", "cost", "environment", "evidence_refs", "note"), label="trial result arm")
    if value["status"] not in ("observed", "missing", "invalid"):
        raise ContractError("trial arm status must be observed, missing or invalid")
    string(value["note"], "trial arm note", 2048)
    refs = value["evidence_refs"]
    if not isinstance(refs, list) or len(refs) > 8:
        raise ContractError("evidence_refs must be at most eight selected references")
    for ref in refs:
        string(ref, "evidence reference", 2048)
    if value["status"] != "observed":
        if any(value[key] is not None for key in ("outcome", "safety_violations", "cost", "environment")):
            raise ContractError("missing/invalid arms require null measurements and environment")
        return
    if _environment(value["environment"]) != environment:
        raise ContractError("observed arm model, tool environment or budgets differ from protocol")
    if not refs:
        raise ContractError("observed arm requires at least one selected evidence reference (not verified)")
    if value["outcome"] is not None and type(value["outcome"]) is not bool:
        raise ContractError("outcome must be a boolean or unknown null, never an assessor score")
    if value["safety_violations"] is not None:
        _integer(value["safety_violations"], "safety_violations")
    cost = value["cost"]
    if cost is not None and (type(cost) not in (int, float) or not math.isfinite(cost) or not 0 <= cost <= MAX_NUMBER):
        raise ContractError("cost must be a finite nonnegative bounded number or unknown null")


def validate_results(protocol, results):
    if not isinstance(results, list) or len(results) > len(protocol["cases"]):
        raise ContractError("results must be a list within the registered case count")
    declared = {case["case_id"] for case in protocol["cases"]}
    seen = set()
    for report in results:
        shape(report, ("case_id", "baseline", "candidate"), label="paired trial result")
        identifier(report["case_id"], "result case_id")
        if report["case_id"] not in declared or report["case_id"] in seen:
            raise ContractError("undeclared or duplicate result case_id")
        seen.add(report["case_id"])
        for key in ("baseline", "candidate"):
            _arm(report[key], protocol["environment"])
    return results


def _reference(value):
    artifact_refs([value])
    return value


def validate_trial_artifact(value):
    """Pure replay validation used for writes AND reads of these owned artifacts."""
    kind, data, bound = value["kind"], data_object(value["data"]), value["bindings"]
    shared = ("schema", "status", "protocol", "limitations")
    if kind == "trial-spec":
        shape(data, (*shared, "proposal", "baseline_revision", "candidate_revision"), label="trial spec data")
        ref = _reference(data["proposal"])
        revision(data["baseline_revision"], policy=True)
        revision(data["candidate_revision"], policy=True)
        if data["baseline_revision"] != bound["policy_revision"] or data["status"] != "registered":
            raise ContractError("trial spec policy/status binding mismatch")
    else:
        shape(data, (*shared, "trial", "results", "review_note", "summary"), label="trial results data")
        ref = _reference(data["trial"])
        if data["status"] != "reported":
            raise ContractError("trial results status must be reported, not verified")
        string(data["review_note"], "review_note", 2048)
    if data["schema"] != SCHEMA or data["limitations"] != LIMITATIONS:
        raise ContractError("trial schema/limitations mismatch")
    if bound.get("artifacts") != [ref] or "proposal_id" in bound:
        raise ContractError("trial artifact must bind its exact single source reference")
    protocol = validate_protocol(data["protocol"])
    if kind == "trial-results":
        validate_results(protocol, data["results"])
        if json_text(data["summary"]) != json_text(summarize(protocol, data["results"])):
            raise ContractError("trial result summary does not match deterministic replay")
    return value


def create_trial(store, request, actor, plan_reader):
    """Return an unsaved owned artifact after strict protocol and lineage checks."""
    action = request["action"]
    if action == "trial_spec":
        shape(request, ("action", "trial_id", "proposal_id", *PROTOCOL_FIELDS), label="trial_spec request")
        entry_id = identifier(request["trial_id"], "trial_id")
        proposal = store.read(identifier(request["proposal_id"], "proposal_id"))
        if proposal["kind"] != "proposal":
            raise ContractError("trial_spec requires a proposal artifact")
        ref = {"id": proposal["id"], "revision": artifact_revision(proposal)}
        protocol = validate_protocol({key: deepcopy(request[key]) for key in PROTOCOL_FIELDS})
        source = proposal
        data = {"schema": SCHEMA, "status": "registered", "proposal": ref,
                "baseline_revision": proposal["bindings"]["policy_revision"],
                "candidate_revision": proposal["data"]["body_hash"],
                "protocol": protocol, "limitations": list(LIMITATIONS)}
        kind = "trial-spec"
    else:
        shape(request, ("action", "trial_id", "trial_revision", "results", "review_note"), label="trial_results request")
        source = store.read(identifier(request["trial_id"], "trial_id"))
        if source["kind"] != "trial-spec":
            raise ContractError("trial_results requires a registered trial-spec")
        revision(request["trial_revision"], policy=True)
        if request["trial_revision"] != artifact_revision(source):
            raise ContractError("stale trial revision")
        ref = {"id": source["id"], "revision": artifact_revision(source)}
        # One final immutable report per fixed protocol; duplicates cannot become
        # extra outcome votes or hide an earlier adverse report.
        entry_id = "trial-result-" + ref["revision"][7:]
        if store.lookup(entry_id) is not None:
            raise ContractError("this trial already has an immutable result report")
        protocol = deepcopy(source["data"]["protocol"])
        results = validate_results(protocol, deepcopy(request["results"]))
        string(request["review_note"], "review_note", 2048)
        data = {"schema": SCHEMA, "status": "reported", "trial": ref, "protocol": protocol,
                "results": results, "review_note": request["review_note"],
                "summary": summarize(protocol, results), "limitations": list(LIMITATIONS)}
        kind = "trial-results"
    bound = {"policy_revision": source["bindings"]["policy_revision"],
             "plans": deepcopy(source["bindings"]["plans"]), "artifacts": [ref]}
    current = store.policy._current()["revision"]
    if current != bound["policy_revision"]:
        raise ContractError("stale trial policy bindings; register against current sources")
    require_lineage(store, bound, plan_reader, policy_revision=current)
    value = {"schema": 1, "id": entry_id, "kind": kind, "created_at": now(),
             "created_by": actor, "bindings": bound, "data": data}
    return validate_trial_artifact(value)
