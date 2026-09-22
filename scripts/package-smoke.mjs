import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const originalHome = process.env.HOME ?? process.env.USERPROFILE;
const repositoryUrl = "https://github.com/moreWax/prime-agent-dsh";
const expectedKeywords = [
  "prime-agent", "prime-agent-package", "pi-package", "context-management", "context-window", "deepseek-harness",
];
const communityFiles = [
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/workflows/ci.yml",
  ".github/workflows/publish.yml",
];
const expected = [
  "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json",
  "docs/context-spill.md", "docs/durable-context-query.md", "docs/shadow-telemetry-validation.md", "docs/single-window-cache-architecture.md",
  "extensions/index.ts", "extensions/shadow-context.ts", "scripts/package-smoke.mjs", "scripts/patch-pi-ai-partial-json.mjs",
  "skills/dsh-context/SKILL.md", "skills/dsh-context/pyproject.toml", "skills/dsh-context/src/dsh_context/__init__.py",
  "src/context-converter.ts", "src/context-objects.ts", "src/context-protocol.ts", "src/context-spill.ts",
  "src/dsh-context-service.ts", "src/durable-context-query.ts", "src/durable-context-store.ts", "src/durable-file-attachments.ts", "src/dsh-image-attachments.ts", "src/prefix-metrics.ts", "src/provider-cache-series.ts", "src/recursive-context-loader.ts", "src/rlm-context-bootstrap.ts", "src/rlm-context-inheritance.ts", "src/shadow-telemetry.ts",
].sort();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

for (const path of communityFiles) {
  const contents = await readFile(join(root, path), "utf8");
  assert(contents.trim().length > 0, `${path} must not be empty`);
}
const ciWorkflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
assert.match(ciWorkflow, /node: \[22, 24\]/, "CI must test all supported Node.js majors");
assert.match(ciWorkflow, /npm ci[\s\S]*npm run release:check/, "CI must validate the clean install");
const publishWorkflow = await readFile(join(root, ".github/workflows/publish.yml"), "utf8");
assert.match(publishWorkflow, /id-token: write/, "npm trusted publishing needs OIDC permission");
assert.match(publishWorkflow, /npm publish --access public --provenance/, "release publishing must include provenance");
assert(!/npm_[A-Za-z0-9]{20,}/.test(publishWorkflow), "publish workflow appears to contain an npm token");

const temp = await mkdtemp(join(tmpdir(), "prime-agent-dsh-pack-"));
try {
  const home = join(temp, "home");
  await (await import("node:fs/promises")).mkdir(home);
  const isolatedEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
  if (originalHome) isolatedEnv.npm_config_cache = join(originalHome, ".npm");
  Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") });
  const packOutput = run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], { cwd: root, env: isolatedEnv });
  const pack = JSON.parse(packOutput)[0];
  assert(pack?.filename, "npm pack did not report a tarball");
  const actual = pack.files.map(({ path }) => path).sort();
  assert.deepEqual(actual, expected, "packed artifact does not match the release allowlist");
  assert(!actual.some((path) => /(^|\/)(test|tests|fixtures)(\/|$)|(?:^|\.)test\.[^/]+$/i.test(path)), "test material leaked into the tarball");
  assert(!actual.some((path) => /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|auth\.json$|credentials?(?:\.|\/|$)|id_rsa$)|\.(?:pem|key|p12)$/i.test(path)), "a secret-bearing filename leaked into the tarball");
  assert(!actual.some((path) => path.startsWith(".github/")), "repository community files leaked into the runtime package");
  assert(!actual.some((path) => /(?:dsh-provider|model-wrapper|agent-pool|branch-checkpoint|acp-client|transparent-routing)/i.test(path)), "legacy model/agent-loop source leaked into the tarball");

  const project = join(temp, "consumer");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(project);
  run(npm, ["init", "--yes"], { cwd: project, env: isolatedEnv });
  const tarball = join(temp, pack.filename);
  run(npm, ["install", "--omit=dev", tarball,
    "@earendil-works/pi-coding-agent@0.86.1", "@earendil-works/pi-ai@0.86.1", "typebox@1.3.34"], { cwd: project, env: isolatedEnv });

  const installed = join(project, "node_modules", "prime-agent-dsh");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.2.0", "packed plugin version is stale");
  assert.deepEqual(manifest.repository, { type: "git", url: `git+${repositoryUrl}.git` });
  assert.equal(manifest.homepage, `${repositoryUrl}#readme`);
  assert.deepEqual(manifest.bugs, { url: `${repositoryUrl}/issues` });
  assert.deepEqual(manifest.publishConfig, { access: "public", provenance: true });
  assert.deepEqual(manifest.keywords, expectedKeywords);
  assert.equal(manifest.funding, undefined, "do not advertise a funding destination that the project does not provide");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.86.1");
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/index.ts"], skills: ["./skills"] });
  const packedReadme = await readFile(join(installed, "README.md"), "utf8");
  assert.match(packedReadme, /Agents[\s\S]*Ctrl\+X[^\n]*twice/);
  assert.match(packedReadme, /Prime deletes the matching session artifact directory/);
  assert.deepEqual(
    Object.keys(manifest.dependencies).filter((name) => name.startsWith("@deepseek-ai/")).sort(),
    ["@deepseek-ai/cordis", "@deepseek-ai/dsh-attachment", "@deepseek-ai/dsh-attachment-local", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-session"],
    "production package must depend only on sidecar DSH components",
  );
  const piAiCandidates = [
    join(installed, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "json-parse.js"),
    join(project, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "json-parse.js"),
  ];
  let patchedPiAi;
  for (const candidate of piAiCandidates) {
    try { patchedPiAi = await readFile(candidate, "utf8"); break; } catch { /* try npm's other legal placement */ }
  }
  assert.match(patchedPiAi ?? "", /\.\.\/\.\.\/\.\.\/\.\.\/partial-json\/dist\/index\.js/, "Bun partial-json compatibility patch was not applied");

  const host = await import(pathToFileURL(join(project, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")));
  const settingsManager = host.SettingsManager.inMemory({ packages: [installed] }, { projectTrusted: true });
  const loader = new host.DefaultResourceLoader({ cwd: project, agentDir: join(temp, "home", ".prime", "agent"), settingsManager, noContextFiles: true });
  await loader.reload();
  let extensions = loader.getExtensions();
  let skills = loader.getSkills();
  assert.equal(extensions.errors.length, 0, JSON.stringify(extensions.errors));
  assert.equal(extensions.extensions.length, 1, "Prime did not discover exactly one package extension");
  assert.equal(extensions.extensions[0].tools.size, 0, "context-sidecar extension must not replace Prime tools");
  assert.equal((extensions.extensions[0].handlers.get("before_agent_start") ?? []).length, 1, "task-aware inheritance admission handler is missing");
  assert((extensions.extensions[0].handlers.get("context") ?? []).length >= 2, "inheritance ordering/context projection handlers are missing");
  for (const event of ["message_end", "model_select", "session_info_changed", "session_shutdown"]) {
    assert((extensions.extensions[0].handlers.get(event) ?? []).length > 0, `${event} native lifecycle handler is missing`);
  }
  assert.equal(extensions.extensions[0].messageRenderers.size, 0, "status must not use a custom message/footer renderer");
  assert(!skills.skills.some(({ name }) => name === "deepseek-harness"), "legacy delegation skill must not ship without its removed tool");
  assert(skills.skills.some(({ name }) => name === "dsh-context"), "Prime did not discover the dsh-context skill");
  assert.equal(skills.diagnostics.length, 0, JSON.stringify(skills.diagnostics));
  const shutdownHandlers = extensions.extensions[0].handlers.get("session_shutdown") ?? [];
  assert(shutdownHandlers.length > 0, "extension did not register session_shutdown cleanup");
  for (const handler of shutdownHandlers) await handler({}, {});

  await loader.reload();
  extensions = loader.getExtensions();
  skills = loader.getSkills();
  assert.equal(extensions.errors.length, 0, "extension reload produced an error");
  assert.equal(extensions.extensions.length, 1, "extension was not retained across reload");
  assert(!skills.skills.some(({ name }) => name === "deepseek-harness"), "legacy delegation skill returned after reload");
  assert(skills.skills.some(({ name }) => name === "dsh-context"), "context skill was not retained across reload");
  console.log(`package smoke passed: ${actual.length} files; production install; extension + context skill discovery; reload`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
