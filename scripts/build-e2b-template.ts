import { Template, defaultBuildLogger } from "e2b";

const TEMPLATE_NAME =
  process.env.E2B_TEMPLATE_NAME?.trim() ||
  "api-migration-autopilot-node24-20260727-v3";

if (!process.env.E2B_API_KEY?.trim()) {
  throw new Error("E2B_API_KEY is required to build the sandbox template.");
}

const template = Template()
  .fromNodeImage("24-bookworm-slim")
  .setUser("root")
  .aptInstall(
    [
      "bash",
      "ca-certificates",
      "git",
      "python3",
      "ripgrep",
      "tar",
      "unzip",
      "zip",
    ],
    { noInstallRecommends: true },
  )
  .runCmd(
    "id -u user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user",
  )
  .runCmd("npm install --global pnpm@10.14.0")
  .runCmd("npm install --prefix /opt/yarn-classic yarn@1.22.22")
  .runCmd("npm install --prefix /opt/yarn-berry @yarnpkg/cli-dist@4.9.4")
  .runCmd(
    String.raw`printf '%s\n' '#!/bin/sh' 'if [ -f "$PWD/package.json" ] && grep -Eq "\"packageManager\"[[:space:]]*:[[:space:]]*\"yarn@([2-9]|[1-9][0-9])" "$PWD/package.json"; then' '  exec node /opt/yarn-berry/node_modules/@yarnpkg/cli-dist/bin/yarn.js "$@"' 'fi' 'if [ -f "$PWD/yarn.lock" ] && grep -q "^__metadata:" "$PWD/yarn.lock"; then' '  exec node /opt/yarn-berry/node_modules/@yarnpkg/cli-dist/bin/yarn.js "$@"' 'fi' 'exec node /opt/yarn-classic/node_modules/yarn/bin/yarn.js "$@"' > /usr/local/bin/yarn && chmod 0755 /usr/local/bin/yarn`,
  )
  .runCmd(
    "node --version && npm --version && pnpm --version && yarn --version && python3 --version && git --version && rg --version | head -n 1",
  )
  .runCmd("chown -R user:user /home/user")
  .setUser("user")
  .setWorkdir("/home/user");

const build = await Template.build(template, TEMPLATE_NAME, {
  apiKey: process.env.E2B_API_KEY.trim(),
  cpuCount: 2,
  memoryMB: 4096,
  skipCache: true,
  onBuildLogs: defaultBuildLogger(),
});

console.log(
  JSON.stringify({
    name: build.name,
    templateId: build.templateId,
    buildId: build.buildId,
  }),
);
