import {
  assessmentFixtures,
  evaluationSpec,
} from "../evaluation/assessment-fixtures";
import { assessMigrationSpec } from "../lib/migration/generic-analyzer";

let expected = 0;
let detected = 0;
let truePositive = 0;
let statusMatches = 0;
const statusMismatches: Array<{
  fixture: string;
  expected: string;
  actual: string;
}> = [];

for (const fixture of assessmentFixtures) {
  const assessment = assessMigrationSpec({
    files: fixture.files,
    spec: evaluationSpec,
  });
  const expectedKeys = new Set(
    fixture.expected.map((item) => `${item.ruleId}:${item.path}`),
  );
  const actualKeys = new Set(
    assessment.findings.map((item) => `${item.ruleId}:${item.path}`),
  );
  expected += expectedKeys.size;
  detected += actualKeys.size;
  truePositive += [...actualKeys].filter((key) => expectedKeys.has(key)).length;
  const expectedStatus =
    fixture.expectedStatus ??
    (fixture.expected.length > 0 ? "partial-coverage" : "no-impact");
  if (assessment.status === expectedStatus) {
    statusMatches += 1;
  } else {
    statusMismatches.push({
      fixture: fixture.id,
      expected: expectedStatus,
      actual: assessment.status,
    });
  }
}

const recall = expected === 0 ? 1 : truePositive / expected;
const precision = detected === 0 ? 1 : truePositive / detected;
const statusAccuracy = statusMatches / assessmentFixtures.length;
const result = {
  fixtureCount: assessmentFixtures.length,
  expectedCandidates: expected,
  detectedCandidates: detected,
  truePositive,
  recall,
  precision,
  statusAccuracy,
  statusMismatches,
  thresholds: {
    fixtureCount: 20,
    recall: 0.9,
    precision: 0.85,
    statusAccuracy: 0.9,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (
  result.fixtureCount < result.thresholds.fixtureCount ||
  recall < result.thresholds.recall ||
  precision < result.thresholds.precision ||
  statusAccuracy < result.thresholds.statusAccuracy
) {
  process.exitCode = 1;
}
