import type { Gap, OpenQuestion, ServiceSuggestion, StrategyAxis, TestStrategyObservation } from "./schema.js";

/**
 * The expertise: how a QA consultant reads a team's testing *practice* and
 * decides what to propose. Each gap rule is a pure function; unknown answers
 * never produce a gap — they produce a question (see QUESTIONS).
 */

type Rule = (o: TestStrategyObservation) => Gap | undefined;

const gap = (g: Gap): Gap => g;

const RULES: Rule[] = [
  (o) =>
    o.strategy.documentExists === "no" || o.strategy.documentExists === "outdated"
      ? gap({
          id: "STR-001",
          axis: "strategy_and_risk",
          severity: o.strategy.documentExists === "no" ? "high" : "medium",
          title: o.strategy.documentExists === "no" ? "No written test strategy" : "Test strategy is outdated",
          observation: `Strategy document: ${o.strategy.documentExists}.`,
          impact: "Without a living strategy, every squad decides alone what to automate and what 'done' means; coverage is uneven and unarguable.",
          recommendation: "Write a one-page strategy per product: risks, layers, what runs where, release criteria, ownership. Review it quarterly.",
          horizon: "30_days",
        })
      : undefined,
  (o) =>
    o.strategy.riskBasedPrioritisation === "no" || o.strategy.riskBasedPrioritisation === "informal"
      ? gap({
          id: "STR-002",
          axis: "strategy_and_risk",
          severity: o.strategy.riskBasedPrioritisation === "no" ? "high" : "medium",
          title: "Tests are not prioritised by business risk",
          observation: `Risk-based prioritisation: ${o.strategy.riskBasedPrioritisation}.`,
          impact: "The team cannot run a fast critical subset on every change, nor explain what a red pipeline blocks. Effort goes where it is easiest, not where failure costs most.",
          recommendation: "Run a risk workshop with product + dev: list journeys, score impact × likelihood, tag P0/P1/P2, and wire the CI gate to P0.",
          horizon: "30_days",
        })
      : undefined,
  (o) => {
    const l = o.strategy.testLayers;
    const missing = Object.entries(l)
      .filter(([k, v]) => v === "none" && k !== "non_functional")
      .map(([k]) => k);
    const onlyE2E = l.e2e_ui === "systematic" && l.unit !== "systematic" && l.api_or_contract !== "systematic";
    if (!missing.length && !onlyE2E) return undefined;
    return gap({
      id: "STR-003",
      axis: "strategy_and_risk",
      severity: onlyE2E ? "high" : "medium",
      title: onlyE2E ? "Inverted test pyramid (E2E carries the load)" : "Missing test layers",
      observation: onlyE2E ? "E2E is systematic while unit/API layers are not." : `Layers absent: ${missing.join(", ")}.`,
      impact: "E2E tests are the slowest and most fragile layer; using them for logic coverage makes feedback slow and failures hard to localise.",
      recommendation: "Push checks down: API/contract tests for business rules, component tests for UI logic, E2E for critical journeys only. Agree the split per feature in refinement.",
      horizon: "90_days",
    });
  },
  (o) =>
    o.strategy.entryExitCriteria === "none"
      ? gap({
          id: "STR-004",
          axis: "strategy_and_risk",
          severity: "medium",
          title: "Definition of Done does not include testing",
          observation: "No entry/exit criteria mentioning tests.",
          impact: "Testing becomes negotiable under deadline pressure; automation debt grows silently.",
          recommendation: "Add to the DoD: acceptance criteria covered, P0 journeys green, no new skipped tests. Make it visible in the ticket.",
          horizon: "30_days",
        })
      : undefined,
  (o) =>
    o.strategy.traceability === "none"
      ? gap({
          id: "STR-005",
          axis: "strategy_and_risk",
          severity: "low",
          title: "No requirement-to-test traceability",
          observation: "Tests are not linked to requirements/tickets.",
          impact: "Coverage questions ('is this feature tested?') cannot be answered without reading code; audits and regulated releases take longer.",
          recommendation: "Link automated tests to tickets through the test-management tool (e.g. Xray test keys in test titles) and publish results back to it from CI.",
          horizon: "60_days",
        })
      : undefined,

  (o) =>
    o.automation.ownership === "qa_only"
      ? gap({
          id: "AUT-001",
          axis: "automation_practice",
          severity: "high",
          title: "Automation is owned by QA alone",
          observation: "Developers do not write or maintain automated tests.",
          impact: "A single QA profile becomes the bottleneck; tests lag features; developers treat failures as 'QA's problem'.",
          recommendation: "Move to shared ownership: developers add/maintain tests with their changes, QA defines standards, reviews and coaches. Start with one squad.",
          horizon: "90_days",
        })
      : undefined,
  (o) =>
    o.automation.standardsDocumented === "no" || o.automation.standardsDocumented === "partial"
      ? gap({
          id: "AUT-002",
          axis: "automation_practice",
          severity: o.automation.standardsDocumented === "no" ? "high" : "medium",
          title: "Automation standards not written down",
          observation: `Standards documented: ${o.automation.standardsDocumented}.`,
          impact: "Every squad invents its own locators, structure and data handling; suites diverge and cannot be supported centrally.",
          recommendation: "Publish a short standard (locators, naming, structure, data, tagging, flaky policy) with a reference example repo. Keep it to a few pages.",
          horizon: "30_days",
        })
      : undefined,
  (o) =>
    o.automation.standardsEnforced === "no" && o.automation.standardsDocumented !== "no"
      ? gap({
          id: "AUT-003",
          axis: "automation_practice",
          severity: "medium",
          title: "Standards exist but are not enforced",
          observation: "No lint rules or review checklist enforce the standard.",
          impact: "Written standards erode within months without automation and review.",
          recommendation: "Add lint rules (no .only, no fixed waits, locator rules) and a merge-request checklist; enforce in CI.",
          horizon: "60_days",
        })
      : undefined,
  (o) =>
    o.automation.testsReviewedInMergeRequests === "no"
      ? gap({
          id: "AUT-004",
          axis: "automation_practice",
          severity: "medium",
          title: "Test code is not reviewed",
          observation: "Tests merge without review.",
          impact: "Smells (sleeps, brittle selectors, missing assertions) enter the suite unchallenged.",
          recommendation: "Review tests like product code; QA reviews the first ones to teach the standard, then the squad takes over.",
          horizon: "30_days",
        })
      : undefined,
  (o) =>
    o.automation.testData === "manual" || o.automation.testData === "shared_fixtures"
      ? gap({
          id: "AUT-005",
          axis: "automation_practice",
          severity: o.automation.testData === "manual" ? "high" : "medium",
          title: "Test data is manual or shared",
          observation: `Test data strategy: ${o.automation.testData}.`,
          impact: "Shared data makes tests order-dependent and non-parallelisable; manual data makes them unrepeatable.",
          recommendation: "Seed or synthesise data per test (API or DB fixtures), with unique identifiers; isolate accounts per worker.",
          horizon: "60_days",
        })
      : undefined,
  (o) =>
    o.automation.environments === "shared_unstable"
      ? gap({
          id: "AUT-006",
          axis: "automation_practice",
          severity: "high",
          title: "Tests run on a shared, unstable environment",
          observation: "The target environment is shared and frequently broken by others.",
          impact: "A large share of failures are environmental; the team stops trusting red pipelines.",
          recommendation: "Stabilise first (health check before the run, deploy freeze windows), then move toward per-branch/ephemeral environments or contract tests to decouple.",
          horizon: "90_days",
        })
      : undefined,
  (o) =>
    o.automation.serviceCatalog === "none"
      ? gap({
          id: "AUT-007",
          axis: "automation_practice",
          severity: "low",
          title: "No automation service offer for squads",
          observation: "Squads have no published way to request automation support.",
          impact: "Support is ad hoc and invisible; the central QA role cannot show or prioritise demand.",
          recommendation: "Publish a small catalogue (e.g. 'bootstrap a Playwright suite', 'stabilise a flaky suite', 'CI integration', 'coaching session') with a request channel and lead times.",
          horizon: "60_days",
        })
      : undefined,

  (o) =>
    o.ci.gate === "none" || o.ci.gate === "nightly_only"
      ? gap({
          id: "CI-001",
          axis: "ci_and_feedback",
          severity: o.ci.gate === "none" ? "critical" : "high",
          title: o.ci.gate === "none" ? "Automated tests do not gate changes" : "Tests only run nightly",
          observation: `CI gate: ${o.ci.gate}.`,
          impact: "Regressions are found hours or days after the change that caused them, by someone else.",
          recommendation: "Run the P0 subset on every merge request (target < 15 min), the full suite nightly.",
          horizon: "30_days",
        })
      : undefined,
  (o) =>
    o.ci.feedbackTimeMinutes !== undefined && o.ci.feedbackTimeMinutes > 30
      ? gap({
          id: "CI-002",
          axis: "ci_and_feedback",
          severity: o.ci.feedbackTimeMinutes > 60 ? "high" : "medium",
          title: "E2E feedback is too slow",
          observation: `Typical E2E job: ${o.ci.feedbackTimeMinutes} min.`,
          impact: "Developers context-switch away; retries and 'merge anyway' become normal.",
          recommendation: "Shard the job, reuse auth state, cache dependencies/browsers, and move the MR gate to the P0 subset.",
          horizon: "60_days",
        })
      : undefined,
  (o) =>
    o.ci.flakyPolicy === "none" || o.ci.flakyPolicy === "retry_and_ignore"
      ? gap({
          id: "CI-003",
          axis: "ci_and_feedback",
          severity: "high",
          title: "No flaky-test policy",
          observation: `Flaky policy: ${o.ci.flakyPolicy}.`,
          impact: "Flake accumulates invisibly, pipelines get longer and greener-by-retry, and a real regression eventually hides behind a retry.",
          recommendation: "Adopt: triage each retried test (flaky family vs regression), quarantine only confirmed flake with a ticket and an expiry, review the quarantine weekly.",
          horizon: "30_days",
        })
      : undefined,
  (o) =>
    o.ci.reportingAndTrends === "none" || o.ci.reportingAndTrends === "per_run_html"
      ? gap({
          id: "CI-004",
          axis: "ci_and_feedback",
          severity: o.ci.reportingAndTrends === "none" ? "high" : "medium",
          title: "No trend view of test health",
          observation: `Reporting: ${o.ci.reportingAndTrends}.`,
          impact: "Nobody can say whether the suite is getting better; improvement work cannot be prioritised or defended.",
          recommendation: "Emit JSON/JUnit, keep artifacts, and track four numbers weekly: pass rate, retried tests, duration, skipped count.",
          horizon: "60_days",
        })
      : undefined,

  (o) =>
    o.people.communityOfPractice === "none" || o.people.communityOfPractice === "informal"
      ? gap({
          id: "PPL-001",
          axis: "people_and_adoption",
          severity: o.people.communityOfPractice === "none" ? "medium" : "low",
          title: "No community of practice with a backlog",
          observation: `Community of practice: ${o.people.communityOfPractice}.`,
          impact: "Standards and tooling improvements have no owner across squads; knowledge stays with individuals.",
          recommendation: "Launch a bi-weekly QA/automation guild with a visible backlog (standards, shared tooling, flaky review) and rotating demos.",
          horizon: "60_days",
        })
      : undefined,
  (o) =>
    o.people.coachingOrOnboarding === "none"
      ? gap({
          id: "PPL-002",
          axis: "people_and_adoption",
          severity: "medium",
          title: "No coaching or onboarding path for automation",
          observation: "New contributors learn by copying existing tests.",
          impact: "Smells propagate; shared ownership cannot happen without a way to learn the standard.",
          recommendation: "Pair on the first tests, run short workshops per squad, and keep a reference repo that embodies the standard.",
          horizon: "90_days",
        })
      : undefined,
  (o) =>
    o.people.aiAssistance === "individual_experiments"
      ? gap({
          id: "PPL-003",
          axis: "people_and_adoption",
          severity: "low",
          title: "AI use in testing is individual and ungoverned",
          observation: "People experiment with AI assistants on their own.",
          impact: "Inconsistent quality, no shared learning, and risk of AI-generated tests that assert nothing or hide failures.",
          recommendation: "Run a governed pilot on one bounded use case (failure triage or test design from acceptance criteria) with review in the loop and measured outcomes.",
          horizon: "90_days",
        })
      : undefined,
];

export function collectGaps(o: TestStrategyObservation): Gap[] {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return RULES.map((r) => r(o))
    .filter((g): g is Gap => Boolean(g))
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// --- Unknowns → questions ----------------------------------------------------

const QUESTIONS: Record<string, [string, string]> = {
  "strategy.documentExists": ["Is there a written test strategy? When was it last updated, and who owns it?", "It decides whether we align to something or write it."],
  "strategy.riskBasedPrioritisation": ["How do you decide which journeys get automated first? Is there a P0/P1 list?", "Prioritisation is the base of every CI gate and coverage decision."],
  "strategy.testLayers.unit": ["Are unit tests systematic in the main repos? Any coverage gate?", "Tells us how much logic coverage E2E is being asked to carry."],
  "strategy.testLayers.integration_or_component": ["Are component or integration tests in place for UI logic?", "Same: where should checks live."],
  "strategy.testLayers.api_or_contract": ["Are APIs tested directly (contract or API tests) in CI?", "The fastest lever to shrink slow E2E suites."],
  "strategy.testLayers.e2e_ui": ["Which E2E suites exist, which squads own them, and do they run in CI?", "Scope of the audit."],
  "strategy.testLayers.non_functional": ["Is performance/accessibility/security tested at all, and where?", "Often required by compliance; usually missing."],
  "strategy.entryExitCriteria": ["Does the Definition of Done mention tests? What blocks a release today?", "Shows whether testing is negotiable under pressure."],
  "strategy.traceability": ["Are tests linked to tickets or requirements (e.g. Xray)? Who looks at that?", "Needed for coverage questions and regulated releases."],
  "automation.ownership": ["Who writes automated tests today — QA, developers, both? Who fixes a broken one?", "Ownership predicts whether improvements stick."],
  "automation.standardsDocumented": ["Is there a written automation standard (locators, structure, data)? Where?", "Determines whether we enforce or author."],
  "automation.standardsEnforced": ["Are those standards enforced by lint or review?", "Written-only standards erode."],
  "automation.testsReviewedInMergeRequests": ["Are test changes reviewed in merge requests like product code?", "Review is where standards are taught."],
  "automation.testData": ["How do tests get their data: manual setup, shared fixtures, seeded per test?", "Drives parallelism and reliability."],
  "automation.environments": ["Which environment do E2E tests target? How often is it broken by someone else?", "Environmental flake is often the largest share."],
  "automation.serviceCatalog": ["Can a squad request automation help today? How, and how long does it take?", "A published offer makes the central role visible and prioritisable."],
  "ci.gate": ["When do automated tests run: on every merge request, nightly, before release, never?", "The gate is the quality system; everything else serves it."],
  "ci.feedbackTimeMinutes": ["How long does the E2E job take on a typical merge request?", "Above ~15–20 min, developers stop waiting."],
  "ci.flakyPolicy": ["What happens when a test fails intermittently? Retry? Skip? Ticket?", "Flake policy decides whether the pipeline can be trusted."],
  "ci.reportingAndTrends": ["Where are test results visible? Is there any trend over time?", "Without trends, improvement cannot be shown."],
  "people.communityOfPractice": ["Is there a QA/automation guild? How often does it meet, and does it own a backlog?", "The vehicle for cross-squad standards."],
  "people.coachingOrOnboarding": ["How does someone new learn to write tests here?", "Shared ownership needs a learning path."],
  "people.aiAssistance": ["Is anyone using AI for test design or failure analysis? Under what rules?", "A governed pilot is low-risk and high-signal; ungoverned use is the opposite."],
};

export function openQuestions(o: TestStrategyObservation): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (node === "unknown") {
      const key = path.join(".");
      const q = QUESTIONS[key];
      if (q) out.push({ field: key, question: q[0], whyItMatters: q[1] });
      return;
    }
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  };
  walk(o, []);
  if (o.ci.feedbackTimeMinutes === undefined) {
    const q = QUESTIONS["ci.feedbackTimeMinutes"]!;
    out.push({ field: "ci.feedbackTimeMinutes", question: q[0], whyItMatters: q[1] });
  }
  return out;
}

export function unknownShare(o: TestStrategyObservation): number {
  let total = 0;
  let unknown = 0;
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      total++;
      if (node === "unknown") unknown++;
    } else if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk({ strategy: o.strategy, automation: o.automation, ci: o.ci, people: o.people });
  return total === 0 ? 1 : unknown / total;
}

// --- Scoring -----------------------------------------------------------------

export const LEVEL_LABELS = ["absent", "ad hoc", "defined", "managed", "optimized"] as const;
const AXES: StrategyAxis[] = ["strategy_and_risk", "automation_practice", "ci_and_feedback", "people_and_adoption"];

export function scoreAxes(o: TestStrategyObservation, gaps: Gap[]) {
  const deduction = { critical: 3, high: 1.5, medium: 1, low: 0.5 };
  return AXES.map((axis) => {
    const mine = gaps.filter((g) => g.axis === axis);
    let score = 4 - mine.reduce((a, g) => a + deduction[g.severity], 0);
    if (mine.some((g) => g.severity === "critical")) score = Math.min(score, 1);
    // Unknowns on this axis cap it at "defined": we cannot certify what we have not seen.
    if (axisHasUnknown(o, axis)) score = Math.min(score, 2);
    const level = Math.max(0, Math.min(4, Math.round(score)));
    const rationale = mine.length
      ? `${mine.length} gap(s): ${mine.map((g) => g.id).slice(0, 3).join(", ")}${mine.length > 3 ? ", …" : "."}`
      : axisHasUnknown(o, axis)
        ? "No gap found, but some answers are unknown; capped at 'defined' until confirmed."
        : "No gap found.";
    return { axis, level, label: LEVEL_LABELS[level]!, rationale };
  });
}

function axisHasUnknown(o: TestStrategyObservation, axis: StrategyAxis): boolean {
  const section = {
    strategy_and_risk: o.strategy,
    automation_practice: o.automation,
    ci_and_feedback: o.ci,
    people_and_adoption: o.people,
  }[axis];
  return JSON.stringify(section).includes('"unknown"');
}

export function overallLevel(levels: number[]): number {
  if (!levels.length) return 0;
  const avg = levels.reduce((a, b) => a + b, 0) / levels.length;
  const min = Math.min(...levels);
  return Math.max(0, Math.min(4, Math.round((avg * 2 + min) / 3)));
}

// --- Services ----------------------------------------------------------------

export function suggestServices(gaps: Gap[]): ServiceSuggestion[] {
  const ids = new Set(gaps.map((g) => g.id));
  const has = (...xs: string[]) => xs.filter((x) => ids.has(x));
  const out: ServiceSuggestion[] = [];
  const push = (s: ServiceSuggestion) => s.gapIds.length && out.push(s);

  push({
    service: "risk_based_strategy_workshop",
    title: "Risk-based test strategy workshop",
    outcome: "A one-page strategy, a P0/P1/P2 journey list, and a Definition of Done the squads agreed to.",
    gapIds: has("STR-001", "STR-002", "STR-003", "STR-004", "STR-005"),
  });
  push({
    service: "e2e_stabilisation_sprint",
    title: "E2E stabilisation (audit + fix PR)",
    outcome: "Measured flakiness, root causes, the most expensive tests fixed in a pull request, and a flaky-test policy the team runs on its own.",
    gapIds: has("CI-003", "AUT-005", "AUT-006"),
  });
  push({
    service: "ci_feedback_loop_improvement",
    title: "CI feedback-loop improvement",
    outcome: "P0 gate on every merge request under ~15 minutes, sharded full run nightly, artifacts and trends visible.",
    gapIds: has("CI-001", "CI-002", "CI-004"),
  });
  push({
    service: "automation_standards_and_coaching",
    title: "Automation standards + coaching",
    outcome: "A written, linted standard with a reference repo; squads writing tests to it with QA review and pairing.",
    gapIds: has("AUT-001", "AUT-002", "AUT-003", "AUT-004", "AUT-007", "PPL-002"),
  });
  push({
    service: "community_of_practice_launch",
    title: "Community of practice launch",
    outcome: "A guild with a cadence, a backlog and demos; standards owned across squads instead of by one person.",
    gapIds: has("PPL-001"),
  });
  push({
    service: "ai_assisted_triage_pilot",
    title: "AI-assisted testing pilot (governed)",
    outcome: "One bounded use case (flaky triage or test design from acceptance criteria) run through an MCP-connected assistant, with review in the loop and measured results.",
    gapIds: has("PPL-003", "CI-003", "CI-004"),
  });
  return out;
}

export function plan(gaps: Gap[]) {
  const by = (h: Gap["horizon"]) => gaps.filter((g) => g.horizon === h).map((g) => `${g.id} — ${g.recommendation}`);
  return { "30_days": by("30_days"), "60_days": by("60_days"), "90_days": by("90_days") };
}
