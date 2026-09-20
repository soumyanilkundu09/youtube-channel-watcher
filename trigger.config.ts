import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // From cloud.trigger.dev → your project → Settings (starts with "proj_"). Not a secret.
  project: "proj_cokhkxevxpbuktmwzacp",
  dirs: ["./src/trigger"],
  runtime: "node",
  maxDuration: 300, // seconds — max compute time per run
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true,
    },
  },
});
