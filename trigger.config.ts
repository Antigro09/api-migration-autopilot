import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_configure_before_deploy",
  runtime: "node-24",
  dirs: ["./trigger"],
  maxDuration: 1_200,
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
