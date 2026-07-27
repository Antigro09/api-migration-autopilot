import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { triggerRuntimePackages } from "../trigger.config";

const require = createRequire(import.meta.url);

test("Trigger production image includes the TypeScript analyzer runtime", () => {
  const packageJson = require("../package.json") as {
    dependencies: Record<string, string>;
  };
  const expectedPackage = `typescript@${packageJson.dependencies.typescript}`;

  assert.deepEqual([...triggerRuntimePackages], [expectedPackage]);
  assert.match(
    require.resolve("typescript/lib/typescript.js"),
    /typescript[\\/]lib[\\/]typescript\.js$/,
  );
});
