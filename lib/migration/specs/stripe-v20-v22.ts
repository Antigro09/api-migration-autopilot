import type { MigrationChangeV1, MigrationSpecV1 } from "../contracts.js";

const changelog = {
  title: "stripe-node changelog",
  url: "https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md",
} as const;

const v21Guide = {
  title: "stripe-node v21 migration guide",
  url: "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v21",
} as const;

const v22Guide = {
  title: "stripe-node v22 migration guide",
  url: "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22",
} as const;

const dahliaApiChangelog = {
  title: "Stripe API Dahlia changelog",
  url: "https://docs.stripe.com/changelog/dahlia",
} as const;

const changes: readonly MigrationChangeV1[] = [
  {
    id: "stripe.runtime.node-18",
    title: "Node.js runtime eligibility",
    description: "stripe-node v21 drops Node.js 16 support; repositories must run Node.js 18 or newer.",
    severity: "error",
    citations: [changelog],
    detector: {
      kind: "syntax-pattern",
      description: "Read engines.node, runtime files, and CI runtime declarations.",
      fileExtensions: [".json", ".yaml", ".yml", ".toml"],
      patternIds: ["package-engines-node", "nvmrc", "node-version", "ci-node-version"],
    },
    transformation: {
      kind: "manual",
      reason: "Runtime upgrades can change deployment infrastructure and are never silently patched.",
    },
    behavioralInvariants: ["The deployment runtime remains controlled by the customer."],
    validationHints: ["Run the repository's test suite on Node.js 18 or newer."],
    autoPatchEligible: false,
    knownLimitations: ["Inherited CI images and externally managed runtimes may not be visible in the repository."],
  },
  {
    id: "stripe.import.cjs-entrypoint",
    title: "Use the v22 CommonJS entry point",
    description: "The CommonJS entry point no longer exposes separate .default or .Stripe properties.",
    severity: "error",
    citations: [changelog, v22Guide],
    detector: {
      kind: "syntax-pattern",
      description: "Find require('stripe').default, require('stripe').Stripe, and destructured Stripe requires.",
      fileExtensions: [".js", ".jsx", ".ts", ".tsx", ".cjs", ".cts", ".mjs", ".mts"],
      patternIds: ["cjs-default-property", "cjs-stripe-property", "cjs-destructure-stripe"],
    },
    transformation: {
      kind: "deterministic",
      transformerId: "stripe-v22-cjs-import",
    },
    behavioralInvariants: ["The local Stripe constructor binding retains its original identifier."],
    validationHints: ["Type-check and load the package from the repository's configured module system."],
    autoPatchEligible: true,
    knownLimitations: ["Dynamic property access and re-export wrappers require review."],
  },
  {
    id: "stripe.constructor.new",
    title: "Construct the Stripe client with new",
    description: "The v22 Stripe export is a true ES class and can no longer be called as a function.",
    severity: "error",
    citations: [changelog, v22Guide],
    detector: {
      kind: "syntax-pattern",
      description: "Find direct calls to a Stripe import/require binding that are not constructor calls.",
      fileExtensions: [".js", ".jsx", ".ts", ".tsx", ".cjs", ".cts", ".mjs", ".mts"],
      patternIds: ["stripe-call-expression"],
    },
    transformation: {
      kind: "deterministic",
      transformerId: "stripe-v22-constructor-new",
    },
    behavioralInvariants: ["Constructor arguments and evaluation order remain unchanged."],
    validationHints: ["Type-check and run client initialization tests."],
    autoPatchEligible: true,
    knownLimitations: ["Aliased or reassigned constructor bindings with ambiguous data flow are reported but not changed."],
  },
  {
    id: "stripe.type.context",
    title: "Rename StripeContext type",
    description: "Stripe.StripeContext is replaced by Stripe.StripeContextType in v22.",
    severity: "error",
    citations: [changelog, v22Guide],
    detector: {
      kind: "syntax-pattern",
      description: "Find Stripe.StripeContext type references.",
      fileExtensions: [".ts", ".tsx", ".cts", ".mts"],
      patternIds: ["stripe-context-type"],
    },
    transformation: {
      kind: "deterministic",
      transformerId: "stripe-v22-context-type",
    },
    behavioralInvariants: ["Only the type name changes; runtime values are untouched."],
    validationHints: ["Run TypeScript type-checking."],
    autoPatchEligible: true,
    knownLimitations: ["String-built type declarations and generated files are not changed."],
  },
  {
    id: "stripe.type.error",
    title: "Replace StripeError type reference",
    description: "Stripe.errors.StripeError is no longer a type; use Stripe.ErrorType for instance annotations.",
    severity: "error",
    citations: [changelog, v22Guide],
    detector: {
      kind: "syntax-pattern",
      description: "Find Stripe.errors.StripeError in TypeScript type positions.",
      fileExtensions: [".ts", ".tsx", ".cts", ".mts"],
      patternIds: ["stripe-error-type"],
    },
    transformation: {
      kind: "deterministic",
      transformerId: "stripe-v22-error-type",
    },
    behavioralInvariants: ["Runtime error-class references and instanceof expressions are not changed."],
    validationHints: ["Run TypeScript type-checking and error-path tests."],
    autoPatchEligible: true,
    knownLimitations: ["Complex conditional types may require manual selection between Stripe.ErrorType and typeof Stripe.errors.StripeError."],
  },
  {
    id: "stripe.decimal.write",
    title: "Construct decimal_string values with Stripe.Decimal",
    description:
      "Dahlia decimal_string request fields use Stripe.Decimal; statically known string literal writes can use Stripe.Decimal.from().",
    severity: "error",
    citations: [changelog, v21Guide, dahliaApiChangelog],
    detector: {
      kind: "syntax-pattern",
      description: "Find known decimal fields initialized from string literals.",
      fileExtensions: [".js", ".jsx", ".ts", ".tsx", ".cjs", ".cts", ".mjs", ".mts"],
      patternIds: ["decimal-field-string-literal"],
    },
    transformation: {
      kind: "deterministic",
      transformerId: "stripe-v21-decimal-write",
    },
    behavioralInvariants: ["The exact decimal character sequence is preserved.", "No floating-point conversion is introduced."],
    validationHints: ["Type-check and test serialized request payloads."],
    autoPatchEligible: true,
    knownLimitations: [
      "Variables, user input, arithmetic, response reads, and JSON serialization require behavioral review.",
      "A usable Stripe namespace binding must be present in the file.",
    ],
  },
  {
    id: "stripe.decimal.read",
    title: "Review decimal_string reads and serialization",
    description: "Dahlia decimal_string response fields are Stripe.Decimal rather than string.",
    severity: "warning",
    citations: [changelog, v21Guide, dahliaApiChangelog],
    detector: {
      kind: "syntax-pattern",
      description: "Find known decimal fields used in string-like operations or external serialization.",
      fileExtensions: [".js", ".jsx", ".ts", ".tsx", ".cjs", ".cts", ".mjs", ".mts"],
      patternIds: ["decimal-field-read"],
    },
    transformation: {
      kind: "model-assisted",
      reason: "Whether to preserve Decimal or call .toString() depends on the receiving API and local behavior.",
    },
    behavioralInvariants: ["Decimal precision must not be reduced.", "External wire formats remain intentional."],
    validationHints: ["Test JSON output and string comparisons for affected fields."],
    autoPatchEligible: false,
    knownLimitations: ["Pure property access does not reveal the expected downstream type."],
  },
  {
    id: "stripe.request.host",
    title: "Move per-request host to client configuration",
    description: "v22 removes per-request host overrides; the host belongs in Stripe client configuration.",
    severity: "error",
    citations: [changelog, v22Guide],
    detector: {
      kind: "syntax-pattern",
      description: "Find request option objects with a host property.",
      fileExtensions: [".js", ".jsx", ".ts", ".tsx", ".cjs", ".cts", ".mjs", ".mts"],
      patternIds: ["per-request-host"],
    },
    transformation: {
      kind: "template",
      transformerId: "stripe-v22-client-host",
      parameters: ["clientBinding", "hostLiteral"],
    },
    behavioralInvariants: [
      "The custom host applies only to the client whose calls previously used that same host.",
      "No mixed-host client is changed automatically.",
    ],
    validationHints: ["Run integration tests that assert the request destination."],
    autoPatchEligible: true,
    knownLimitations: [
      "A deterministic patch is offered only for one local client and one consistent literal host.",
      "Mixed hosts, spread options, shared clients, and non-literal hosts require manual migration.",
    ],
  },
  {
    id: "stripe.request.legacy-arguments",
    title: "Review removed callback and API-key call patterns",
    description: "v22 removes callbacks, plain API-key arguments, and mixed params/options semantics.",
    severity: "warning",
    citations: [changelog, v22Guide],
    detector: {
      kind: "syntax-pattern",
      description: "Find likely callbacks, string API-key arguments, and option keys in params objects.",
      fileExtensions: [".js", ".jsx", ".ts", ".tsx", ".cjs", ".cts", ".mjs", ".mts"],
      patternIds: ["callback-argument", "plain-api-key-argument", "options-in-params"],
    },
    transformation: {
      kind: "model-assisted",
      reason: "The correct async control flow and request parameter separation depend on surrounding behavior.",
    },
    behavioralInvariants: ["Request authentication, error propagation, and completion behavior remain equivalent."],
    validationHints: ["Run API-client unit tests and tests for error paths."],
    autoPatchEligible: false,
    knownLimitations: ["Static detection is conservative and may report wrapper APIs for review."],
  },
];

export const stripeV20ToV22Spec: MigrationSpecV1 = {
  schemaVersion: "1",
  id: "reference.stripe-node.20-to-22",
  revision: 1,
  campaignKind: "independent-reference",
  provider: {
    id: "stripe",
    displayName: "Stripe",
    verifiedSponsor: false,
  },
  product: {
    id: "stripe-node",
    displayName: "stripe-node",
  },
  ecosystem: "node",
  language: "typescript-javascript",
  packageName: "stripe",
  sourceRange: ">=20.3.0 <21.0.0",
  targetVersion: "22.1.0",
  pinnedApiVersion: "2026-03-25.dahlia",
  minimumRuntime: {
    name: "node",
    version: ">=18",
  },
  sourceArtifacts: [
    { id: "stripe-node-changelog", ...changelog },
    { id: "stripe-node-v21-guide", ...v21Guide },
    { id: "stripe-node-v22-guide", ...v22Guide },
    { id: "stripe-api-dahlia", ...dahliaApiChangelog },
  ],
  changes,
};

export const stripeChangeById = new Map(stripeV20ToV22Spec.changes.map((change) => [change.id, change]));
