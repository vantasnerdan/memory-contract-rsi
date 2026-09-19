# Instruction audits and paired outcome trials

These mechanisms support reward-shaped guidance: reward useful outcomes and evidence-led synthesis, not calls, length, model scores or automatic permissions. They do not train model weights. They do not automatically modify a policy, prompt, AGENTS file, skill or template.

## Audit the selected instruction stack

```js
memory_rsi({action: "audit", request: JSON.stringify({
  sources: [
    {id: "host-guidance", kind: "system", scope: "selected host contribution", body: "...explicitly selected text..."},
    {id: "project-guidance", kind: "agents", scope: "this repository", body: "..."},
    {id: "coding-skill", kind: "skill", scope: "selected coding work", body: "..."},
    {id: "coding-template", kind: "template", scope: "selected coding contract", body: "..."}
  ],
  plan_id: "my-plan" // optional; includes the pinned contract and exception reviews
})})
```

- Select **1–5 text sources**. Kinds: `system`, `agents`, `skill`, `template`, `memory`. Canonical policy is included automatically as `canonical-policy` (reserved ID).
- Each source has exactly `id`, `kind`, `scope`, `body`. IDs are unique, bounded identifiers; scope is a short declared applicability statement. Bodies have the existing 32,768-codepoint bound; the combined snapshot has a 64 KiB technical byte budget. Oversized selections fail explicitly, not by silently clipping instructions.
- No path is dereferenced and no prompt/history is captured. Review selected content before disclosure to the configured, opt-in TypeSafe endpoint.
- Exact source bodies and content hashes are retained with the canonical policy/plan revisions. Kind and scope are **caller declarations**, not authenticated runtime priority. Source snapshots are not monitored for later filesystem changes; reselect/re-audit after editing them.
- Typed questions inspect each source and each selected pair for contradictions, redundant guidance, misplaced detail, complementary guidance and legitimate scope differences. Optional plan checking considers the selected layers. Findings link exact source snapshots, not fabricated quotes or claims to inspect unseen layers.
- Low confidence, ambiguous distributions and unknown scope remain uncertain. “No issue detected in selection” does not mean the entire instruction stack is conflict-free.

Resolve authority/scope before wording. Prefer a coherent replacement, merge or retirement with one maintained owner; do not paste another incident-specific instruction into every layer. Edits to canonical policy, owner-managed system prompts/AGENTS, skills and pinned templates use their separate version/review mechanisms. Auditing cannot weaken active plans or platform boundaries.

## Register a trial before recording results

First create a normal revision-bound proposal. `trial_spec` registers one immutable protocol against that exact proposal, including baseline/candidate policy revisions. It is local-only and does not execute agents or invoke TypeSafe.

```js
memory_rsi({action: "trial_spec", request: JSON.stringify({
  trial_id: "coherent-guidance-trial-1",
  proposal_id: "coherent-guidance-candidate",
  hypothesis: "Clarifying evidence review reduces unsupported completion without unnecessary steps.",
  procedure: "Use the fixed task fixtures and same model/tool budgets; counterbalance run order; inspect actual artifacts against the prespecified criteria.",
  stopping_rule: "Run every registered case once per arm, retaining failures and missing measurements; do not stop after favorable outcomes.",
  environment: {agent_model: "pinned-model-id", tool_environment: "tool-and-fixture-version", max_tokens: 10000, max_steps: 100},
  metrics: {outcome: "The task-specific observable acceptance check is met", safety: "Count any permission bypass or fabricated test result", cost_unit: "tokens"},
  cases: [
    {case_id: "task-dev", revision: "sha256:<64 lowercase hex case digest>", split: "development", family: "task-family-a"},
    {case_id: "task-holdout", revision: "sha256:<64 lowercase hex case digest>", split: "holdout", family: "task-family-b"},
    {case_id: "task-control", revision: "sha256:<64 lowercase hex case digest>", split: "control", family: "task-family-c"}
  ]
})})
```

Register at most 64 fixed paired units. Replicates get distinct case IDs but the same family. Keep holdout families separate from development; the report exposes cross-split family overlap. Case digests/references are caller-selected identifiers, not file reads. `environment` fixes model, tool context and budgets for comparable arms; mismatches reject. Supported cost units: `tokens`, `milliseconds`, `usd`, `units`.

Registration proves ordering before result **recording** only; it cannot prove experiments were not run earlier. Freeze real fixtures, randomize/counterbalance run order, preserve artifacts and arrange independent review outside this bookkeeping API. Author and reviewer labels are not attestations.

## Report actual paired measurements

```js
const environment = {agent_model: "pinned-model-id", tool_environment: "tool-and-fixture-version", max_tokens: 10000, max_steps: 100};
const observed = (outcome, cost, reference) => ({
  status: "observed", outcome, safety_violations: 0, cost, environment,
  evidence_refs: [reference], note: "Describe the actual check and limitations, not a model preference."
});
memory_rsi({action: "trial_results", request: JSON.stringify({
  trial_id: "coherent-guidance-trial-1",
  trial_revision: "sha256:<exact returned trial artifact revision>",
  results: [{case_id: "task-holdout",
    baseline: observed(false, 1200, "artifact:baseline-run"),
    candidate: observed(true, 1250, "artifact:candidate-run")
  }],
  review_note: "Reported measurements; references require independent inspection."
})})
```

**Illustration only:** do not copy example numbers as evidence. Run the actual comparison first. For missing/invalid arms use `status:"missing"` or `"invalid"`, `outcome:null`, `safety_violations:null`, `cost:null`, `environment:null`, explicit `evidence_refs` and `note`. Unknown metrics in observed arms remain null and counted as unknown; they are never zero/pass. Omitted cases remain in registered denominators. Duplicate/undeclared cases, nonfinite values, negative costs or violations, invalid revisions and environment mismatches reject.

One immutable result report per protocol prevents silently replacing an adverse/missing report. Plan complete capture before reporting; further observations need another explicit registered trial. Exact protocol/results ancestry remains revision-bound; stale or missing sources do not become fresh evidence.

Summaries expose development/holdout/control and total paired denominators, success rates/deltas, wins/losses/ties, missingness, safety violations/regressions and separate cost deltas. No weighted score can compensate for a boundary violation. Source-family counts are descriptive, not proof of independent samples; no statistical significance or causal improvement is inferred.

## TypeSafe review of reported trials

```js
memory_rsi({action: "trial_review", request: JSON.stringify({results_id: "<trial-results artifact id>"})})
```

This opt-in remote review selects the exact saved protocol, result notes, computed summaries and limitations. TypeSafe judges comparability, reported support and evidence reviewability. It never opens referenced files. The review binds exact result ancestry and is retained as an immutable `trial_review` artifact.

Interpretation cannot turn missing pairs, absent holdout coverage, declared family leakage, uncertain judgments or unknown safety into a positive gain claim. Safety regressions retain the baseline; adverse outcome/cost tradeoffs remain separate. Even `reported-gain-for-review` means **descriptive caller-reported gain for further review**, not verified behavior, causal improvement, achievement credit or promotion permission.

These trial reports are a separately reviewable evidence path. They do not automatically rewrite proposal/evaluation/promotion requirements, feed the mining corpus, or become independent votes merely because TypeSafe reviewed them. The reasoning agent must inspect actual evidence and cite it during explicit change review.

## Plan and evaluation changes

Preflight now retains all capability exceptions and recorded review history, including latest rejection/unreviewed status, while omitting outcome claims before work. A refreshed preflight can see a resolution instead of repeatedly flagging an invisible exception. This never changes the pinned requirement or independently verifies the exception.

Candidate evaluation reports comparison coverage and reason codes. Missing, low-confidence, insufficient or all-equivalent comparisons no longer imply a candidate advantage; quality/maintenance concerns require revision. These remain advisory judgments rather than authorization gates. Large plan responses preserve valid structured JSON and receipt/status information with explicit omissions instead of prefix-truncating away coaching.

See [ranked review and validation](rsi-improvement-review.md) for baseline findings and measured delivery evidence.
