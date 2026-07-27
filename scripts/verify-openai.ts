import { OpenAIModelGateway } from "../lib/integrations/model";

if (!process.env.OPENAI_API_KEY?.trim()) {
  throw new Error("OPENAI_API_KEY is required.");
}

const gateway = new OpenAIModelGateway();
const organizationId = "verification-organization";
const candidate = {
  id: "verification-candidate",
  ruleId: "verification.constructor",
  path: "src/client.ts",
  snippet: "const client = oldClient();",
  start: 15,
  end: 26,
  localConventions: ["TypeScript", "ES modules"],
};
const evidence = {
  id: "verification-evidence",
  title: "Synthetic migration evidence",
  citation: "Verification fixture",
  text: "The oldClient() constructor must be replaced with new Client().",
};

const classification = await gateway.classify({
  organizationId,
  candidates: [candidate],
  evidence: [evidence],
  allowedPaths: [candidate.path],
  consentPolicyVersion: "verification-only",
});
if (
  classification.output.classifications.length !== 1 ||
  classification.output.classifications[0]?.candidateId !== candidate.id
) {
  throw new Error("The classification model did not satisfy its output contract.");
}

const residual = await gateway.generateResidualEdits({
  organizationId,
  candidates: [candidate],
  evidence: [evidence],
  allowedPaths: [candidate.path],
  invariants: ["Keep the client assigned to the same local variable."],
  consentPolicyVersion: "verification-only",
});
if (
  residual.output.edits.length + residual.output.unresolved.length !== 1
) {
  throw new Error("The residual model did not account for the test candidate.");
}

console.log(
  JSON.stringify({
    classification: {
      model: classification.model,
      responseId: classification.responseId,
      inputTokens: classification.inputTokens,
      outputTokens: classification.outputTokens,
    },
    residual: {
      model: residual.model,
      responseId: residual.responseId,
      inputTokens: residual.inputTokens,
      outputTokens: residual.outputTokens,
      disposition:
        residual.output.edits.length === 1 ? "edited" : "unresolved",
    },
  }),
);
