import { Sandbox } from "e2b";

const apiKey = process.env.E2B_API_KEY?.trim();
const templateId = process.env.E2B_TEMPLATE_ID?.trim();
const imageVersion = process.env.E2B_ASSESSMENT_IMAGE_VERSION?.trim();
const registryHosts = (process.env.E2B_REGISTRY_HOSTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!apiKey || !templateId || !imageVersion || registryHosts.length === 0) {
  throw new Error(
    "E2B_API_KEY, E2B_TEMPLATE_ID, E2B_ASSESSMENT_IMAGE_VERSION, and E2B_REGISTRY_HOSTS are required.",
  );
}
if (
  registryHosts.some(
    (host) => host.toLowerCase() !== "registry.npmjs.org",
  )
) {
  throw new Error(
    "E2B_REGISTRY_HOSTS may contain only the approved public npm registry host.",
  );
}

const offlineSandbox = await Sandbox.create(templateId, {
  apiKey,
  timeoutMs: 120_000,
  secure: true,
  allowInternetAccess: false,
  network: {
    denyOut: ["0.0.0.0/0"],
    allowPublicTraffic: false,
  },
  lifecycle: { onTimeout: "kill" },
  envs: {},
  metadata: {
    product: "api-migration-autopilot",
    phase: "template-verification",
  },
});

let runtimeLines: string[] = [];
try {
  const runtime = await offlineSandbox.commands.run(
    "node --version && npm --version && pnpm --version && yarn --version && python3 --version && whoami && pwd",
    { cwd: "/home/user", requestTimeoutMs: 30_000 },
  );
  runtimeLines = runtime.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (
    !runtimeLines[0]?.startsWith("v24.") ||
    !runtimeLines[4]?.startsWith("Python 3.") ||
    runtimeLines[5] !== "user" ||
    runtimeLines[6] !== "/home/user"
  ) {
    throw new Error("The E2B template runtime identity or Node version is invalid.");
  }

  const isolation = await offlineSandbox.commands.run(
    "node -e 'fetch(\"https://registry.npmjs.org\", { signal: AbortSignal.timeout(5000) }).then(() => process.exit(41)).catch(() => process.exit(0))'",
    { cwd: "/home/user", requestTimeoutMs: 10_000 },
  );
  if (isolation.exitCode !== 0) {
    throw new Error("The no-network E2B verification sandbox reached the internet.");
  }

} finally {
  await offlineSandbox.kill();
}

const registrySandbox = await Sandbox.create(templateId, {
  apiKey,
  timeoutMs: 120_000,
  secure: true,
  allowInternetAccess: true,
  network: {
    allowOut: registryHosts,
    denyOut: ["0.0.0.0/0"],
    allowPublicTraffic: false,
  },
  lifecycle: { onTimeout: "kill" },
  envs: {},
  metadata: {
    product: "api-migration-autopilot",
    phase: "template-registry-verification",
  },
});

try {
  await registrySandbox.files.makeDir("/home/user/registry-check");
  await registrySandbox.files.write(
    "/home/user/registry-check/package.json",
    JSON.stringify({
      private: true,
      dependencies: { "is-number": "7.0.0" },
    }),
  );
  await registrySandbox.commands.run(
    "npm install --ignore-scripts --no-audit --no-fund && node -e 'if (require(\"is-number\")(7) !== true) process.exit(42)'",
    { cwd: "/home/user/registry-check", requestTimeoutMs: 60_000 },
  );
  const unrelated = await registrySandbox.commands.run(
    "node -e 'fetch(\"https://example.com\", { signal: AbortSignal.timeout(5000) }).then(() => process.exit(41)).catch(() => process.exit(0))'",
    { cwd: "/home/user", requestTimeoutMs: 10_000 },
  );
  if (unrelated.exitCode !== 0) {
    throw new Error("The registry-only E2B sandbox reached an unrelated host.");
  }
} finally {
  await registrySandbox.kill();
}

console.log(
  JSON.stringify({
    templateId,
    imageVersion,
    node: runtimeLines[0],
    npm: runtimeLines[1],
    pnpm: runtimeLines[2],
    yarn: runtimeLines[3],
    python: runtimeLines[4],
    user: runtimeLines[5],
    workdir: runtimeLines[6],
    offlineNetwork: "denied",
    registryEgress: "npm-only",
    unrelatedEgress: "denied",
  }),
);
