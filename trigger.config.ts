import { defineConfig } from "@trigger.dev/sdk";
import { additionalPackages } from "@trigger.dev/build/extensions/core";

export const triggerRuntimePackages = ["typescript@5.9.3"] as const;

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_configure_before_deploy",
  runtime: "node-24",
  dirs: ["./trigger"],
  maxDuration: 1_200,
  build: {
    extensions: [
      additionalPackages({ packages: [...triggerRuntimePackages] }),
    ],
  },
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 5,
      factor: 2,
      minTimeoutInMs: 2_000,
      maxTimeoutInMs: 60_000,
      randomize: true,
    },
  },
});
