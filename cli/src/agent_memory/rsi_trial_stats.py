"""Deterministic paired summaries of caller-reported outcomes, never causal credit.

All denominators come from the preregistered manifest. Missing arms/metrics stay
unknown; safety and cost are separate from useful-outcome differences. Source
families are declared dependence groups, not authenticated independence.
"""
from __future__ import annotations

from decimal import Decimal

SPLITS = ("development", "holdout", "control")


def _sum(values):
    # Decimal text avoids spurious cost regressions from binary summation noise.
    return float(sum((Decimal(str(value)) for value in values), Decimal(0)))


def _group(cases, reports, unit):
    pairs = [(reports.get(case["case_id"], {}).get("baseline"),
              reports.get(case["case_id"], {}).get("candidate")) for case in cases]

    def known(arm, metric):
        return arm is not None and arm["status"] == "observed" and arm[metric] is not None

    def paired(metric):
        return [(left[metric], right[metric]) for left, right in pairs
                if known(left, metric) and known(right, metric)]

    outcomes = paired("outcome")
    baseline = sum(left for left, _ in outcomes)
    candidate = sum(right for _, right in outcomes)
    size = len(outcomes)
    outcome = {"paired": size, "missing_or_unknown": len(cases) - size,
               "baseline_successes": baseline, "candidate_successes": candidate,
               "delta_successes": candidate - baseline,
               "baseline_rate": baseline / size if size else None,
               "candidate_rate": candidate / size if size else None,
               "delta_rate": (candidate - baseline) / size if size else None,
               "wins": sum(right > left for left, right in outcomes),
               "losses": sum(right < left for left, right in outcomes),
               "ties": sum(right == left for left, right in outcomes)}
    safety_pairs = paired("safety_violations")
    safety = {"paired": len(safety_pairs), "missing_or_unknown": len(cases) - len(safety_pairs),
              "baseline_violations": sum(left for left, _ in safety_pairs),
              "candidate_violations": sum(right for _, right in safety_pairs),
              "delta_violations": sum(right - left for left, right in safety_pairs),
              "regressed_pairs": sum(right > left for left, right in safety_pairs),
              "known_candidate_violations": sum(right["safety_violations"] for _, right in pairs if known(right, "safety_violations"))}
    costs = paired("cost")
    cost = {"paired": len(costs), "missing_or_unknown": len(cases) - len(costs),
            "baseline_total": _sum(left for left, _ in costs),
            "candidate_total": _sum(right for _, right in costs),
            "delta_total": _sum(Decimal(str(right)) - Decimal(str(left)) for left, right in costs),
            "mean_delta": _sum(Decimal(str(right)) - Decimal(str(left)) for left, right in costs) / len(costs) if costs else None,
            "regressed_pairs": sum(right > left for left, right in costs), "unit": unit}
    states = {"observed": 0, "missing": 0, "invalid": 0}
    for left, right in pairs:
        for arm in (left, right):
            states[arm["status"] if arm else "missing"] += 1
    return {"registered_cases": len(cases), "reported_cases": sum(case["case_id"] in reports for case in cases),
            "source_families": len({case["family"] for case in cases}), "arm_statuses": states,
            "outcome": outcome, "safety": safety, "cost": cost}


def summarize(protocol, results):
    """No inference, file reads, statistical independence or reward scalar."""
    cases = protocol["cases"]
    reports = {report["case_id"]: report for report in results}
    unit = protocol["metrics"]["cost_unit"]
    total = _group(cases, reports, unit)
    splits = {split: _group([case for case in cases if case["split"] == split], reports, unit) for split in SPLITS}
    family_splits = {}
    for case in cases:
        family_splits.setdefault(case["family"], set()).add(case["split"])
    overlap = [{"family": family, "splits": sorted(values)} for family, values in sorted(family_splits.items()) if len(values) > 1]
    flags = []
    if not total["outcome"]["paired"]:
        flags.append("no-observed-pairs")
    if not splits["holdout"]["outcome"]["paired"]:
        flags.append("no-heldout-pairs")
    if not splits["control"]["outcome"]["paired"]:
        flags.append("no-control-pairs")
    if overlap:
        flags.append("cross-split-family-overlap")
    if total["source_families"] < 2:
        flags.append("single-source-family")
    if total["outcome"]["missing_or_unknown"]:
        flags.append("missing-outcomes")
    if total["safety"]["missing_or_unknown"]:
        flags.append("unknown-safety")
    if total["safety"]["regressed_pairs"]:
        flags.append("safety-regression")
    if total["safety"]["known_candidate_violations"]:
        flags.append("candidate-boundary-violations")
    if total["cost"]["missing_or_unknown"]:
        flags.append("unknown-cost")
    if total["cost"]["regressed_pairs"]:
        flags.append("cost-regression")
    if splits["holdout"]["outcome"]["losses"]:
        flags.append("holdout-regression")
    if splits["control"]["outcome"]["losses"]:
        flags.append("control-regression")
    return {"total": total, "splits": splits, "cross_split_families": overlap,
            "unreported_cases": [case["case_id"] for case in cases if case["case_id"] not in reports],
            "limitations": flags, "automatic_promotion": False, "verified_improvement": False,
            "meaning": "Deterministic differences of selected caller-reported paired outcomes. Rates use only known paired measurements; missingness uses the full fixed manifest. Shared family IDs indicate dependence; different IDs do not prove independence. No statistical accuracy, causal improvement, authenticated review or permission is established."}
