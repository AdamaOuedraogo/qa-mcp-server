import { z } from "zod";

/**
 * Test Strategy Assessment — data contract.
 *
 * `audit_test_suite` reads code. This capability reads the *practice*: the
 * strategy document, the way the team prioritises, gates, owns and reviews
 * its tests. None of that is in a spec file, so the observation is a typed
 * questionnaire an agent fills from documents and interviews. Every field
 * accepts "unknown": not knowing is an honest observation, and the judgment
 * turns each unknown into a question to ask on day one.
 *
 *   Raw Data (what the team says and writes)  ->  QA Expertise  ->  Structured Judgment
 */

const tri = <T extends [string, ...string[]]>(values: T) => z.enum([...values, "unknown"] as [...T, "unknown"]);

export const LayerPresenceSchema = tri(["none", "ad_hoc", "systematic"]);

export const TestStrategyObservationSchema = z.object({
  context: z
    .object({
      productType: z.string().max(200).optional().describe("e.g. 'B2C web + mobile banking app'."),
      teamsInScope: z.number().int().nonnegative().optional(),
      releaseCadence: tri(["on_demand", "weekly_or_faster", "biweekly", "monthly_or_slower"]).optional(),
      regulated: z.boolean().optional().describe("Compliance constraints (finance, health…)."),
    })
    .optional(),

  strategy: z.object({
    documentExists: tri(["no", "outdated", "living"]).describe("Is there a written test strategy, and is it maintained?"),
    riskBasedPrioritisation: tri(["no", "informal", "explicit"]).describe("Are tests/journeys classified by business risk (P0/P1/P2)?"),
    testLayers: z.object({
      unit: LayerPresenceSchema,
      integration_or_component: LayerPresenceSchema,
      api_or_contract: LayerPresenceSchema,
      e2e_ui: LayerPresenceSchema,
      non_functional: LayerPresenceSchema.describe("Performance, accessibility, security."),
    }),
    entryExitCriteria: tri(["none", "informal", "defined"]).describe("Definition of Done / release criteria mention tests?"),
    traceability: tri(["none", "manual", "tooled"]).describe("Requirements ↔ tests link, e.g. via Jira Xray."),
  }),

  automation: z.object({
    ownership: tri(["qa_only", "shared", "dev_owned"]).describe("Who writes and maintains automated tests?"),
    standardsDocumented: tri(["no", "partial", "yes"]).describe("Locator, naming, structure, data conventions written down?"),
    standardsEnforced: tri(["no", "review_only", "lint_and_review"]),
    testsReviewedInMergeRequests: tri(["no", "sometimes", "always"]),
    testData: tri(["manual", "shared_fixtures", "seeded_or_synthetic_per_test"]),
    environments: tri(["shared_unstable", "shared_stable", "ephemeral_or_per_branch"]),
    serviceCatalog: tri(["none", "informal", "published"]).describe("A published 'automation service offer' squads can request."),
  }),

  ci: z.object({
    gate: tri(["none", "nightly_only", "on_merge_request", "on_merge_request_plus_nightly"]),
    feedbackTimeMinutes: z.number().int().positive().optional().describe("Typical E2E job duration."),
    flakyPolicy: tri(["none", "retry_and_ignore", "quarantine_with_ticket_and_expiry"]),
    reportingAndTrends: tri(["none", "per_run_html", "dashboard_with_trends"]),
  }),

  people: z.object({
    communityOfPractice: tri(["none", "informal", "regular_with_backlog"]).describe("A QA/automation guild that meets and owns a backlog."),
    coachingOrOnboarding: tri(["none", "ad_hoc", "structured"]),
    aiAssistance: tri(["none", "individual_experiments", "governed_pilot", "integrated"]).describe("Use of AI for test design/analysis and how it is governed."),
  }),
});
export type TestStrategyObservation = z.infer<typeof TestStrategyObservationSchema>;

// --- Judgment -----------------------------------------------------------------

export const StrategyAxisSchema = z.enum([
  "strategy_and_risk",
  "automation_practice",
  "ci_and_feedback",
  "people_and_adoption",
]);
export type StrategyAxis = z.infer<typeof StrategyAxisSchema>;

export const GapSchema = z.object({
  id: z.string(),
  axis: StrategyAxisSchema,
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string(),
  observation: z.string(),
  impact: z.string(),
  recommendation: z.string(),
  horizon: z.enum(["30_days", "60_days", "90_days"]),
});
export type Gap = z.infer<typeof GapSchema>;

export const OpenQuestionSchema = z.object({
  field: z.string().describe("Dotted path of the unknown field."),
  question: z.string().describe("What to ask the team, in their words."),
  whyItMatters: z.string(),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

/**
 * A service a QA consultancy can propose in response to the gaps. Generic by
 * design: names describe outcomes, not a specific vendor's catalogue.
 */
export const ServiceSuggestionSchema = z.object({
  service: z.enum([
    "e2e_stabilisation_sprint",
    "ci_feedback_loop_improvement",
    "risk_based_strategy_workshop",
    "automation_standards_and_coaching",
    "community_of_practice_launch",
    "ai_assisted_triage_pilot",
  ]),
  title: z.string(),
  outcome: z.string(),
  gapIds: z.array(z.string()),
});
export type ServiceSuggestion = z.infer<typeof ServiceSuggestionSchema>;

export const TestStrategyJudgmentSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  axes: z.array(
    z.object({
      axis: StrategyAxisSchema,
      level: z.number().int().min(0).max(4),
      label: z.string(),
      rationale: z.string(),
    }),
  ),
  overallLevel: z.number().int().min(0).max(4),
  overallLabel: z.string(),
  gaps: z.array(GapSchema),
  openQuestions: z.array(OpenQuestionSchema),
  plan: z.object({
    "30_days": z.array(z.string()),
    "60_days": z.array(z.string()),
    "90_days": z.array(z.string()),
  }),
  services: z.array(ServiceSuggestionSchema),
  confidence: z.number().min(0).max(1).describe("Falls as the share of unknown fields rises."),
});
export type TestStrategyJudgment = z.infer<typeof TestStrategyJudgmentSchema>;
