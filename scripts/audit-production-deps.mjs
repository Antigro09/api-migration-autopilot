import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const lockfile = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const packages = {};
for (const [path, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (!path || !metadata.version || metadata.dev === true) continue;
  const segments = path.split("node_modules/");
  const name = metadata.name ?? segments.at(-1);
  if (!name) continue;
  (packages[name] ??= []).push(metadata.version);
}
for (const name of Object.keys(packages)) {
  packages[name] = [...new Set(packages[name])];
}

const response = await fetch(
  "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
  {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(packages),
  },
);
const bytes = Buffer.from(await response.arrayBuffer());
const decoded =
  bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
const text = decoded.toString("utf8");
if (!response.ok) {
  throw new Error(
    `The npm advisory service returned HTTP ${response.status}: ${text.slice(0, 500)}`,
  );
}
const advisories = JSON.parse(text);
const entries = Object.entries(advisories).flatMap(([moduleName, matches]) =>
  Array.isArray(matches)
    ? matches.map((advisory) => ({
        ...advisory,
        module_name: advisory.name ?? moduleName,
      }))
    : [],
);
const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
for (const advisory of entries) {
  if (advisory?.severity in counts) counts[advisory.severity] += 1;
}
console.log(
  `Production dependency audit: ${entries.length} advisories ` +
    `(critical ${counts.critical}, high ${counts.high}, moderate ${counts.moderate}, low ${counts.low}).`,
);
for (const advisory of entries) {
  console.log(
    `${String(advisory.severity).toUpperCase()} ${advisory.module_name} ` +
      `${advisory.id ?? advisory.url ?? "advisory"}: ${advisory.title} ` +
      `(affected ${advisory.vulnerable_versions ?? "unspecified"})`,
  );
}
if (counts.critical > 0 || counts.high > 0) process.exitCode = 1;
