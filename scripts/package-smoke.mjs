import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const originalHome = process.env.HOME ?? process.env.USERPROFILE;
const expected = [
  "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json",
  "docs/context-spill.md", "docs/durable-context-query.md", "docs/inference-context-plan.md", "docs/shadow-telemetry-validation.md",
  "extensions/index.ts", "extensions/shadow-context.ts", "scripts/package-smoke.mjs", "scripts/patch-pi-ai-partial-json.mjs",
  "skills/dsh-context/SKILL.md", "skills/dsh-context/pyproject.toml", "skills/dsh-context/src/dsh_context/__init__.py",
  "src/compaction.ts", "src/context-converter.ts", "src/context-objects.ts", "src/context-pressure.ts", "src/context-protocol.ts", "src/context-spill.ts",
  "src/dsh-context-service.ts", "src/durable-context-query.ts", "src/durable-context-store.ts", "src/durable-file-attachments.ts", "src/dsh-image-attachments.ts", "src/prefix-metrics.ts", "src/provider-cache-series.ts", "src/recursive-context-loader.ts", "src/rlm-context-bootstrap.ts", "src/rlm-context-inheritance.ts", "src/shadow-telemetry.ts", "src/standalone-compaction-planner.ts",
].sort();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

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
  assert(!actual.some((path) => /(^|\/)(test|tests|fixtures)(\/|$)/i.test(path)), "test material leaked into the tarball");
  assert(!actual.some((path) => /(^|\/)(\.env|auth\.json|credentials?)(\.|\/|$)/i.test(path)), "a secret-bearing filename leaked into the tarball");
  assert(!actual.some((path) => /(?:dsh-provider|model-wrapper|agent-pool|branch-checkpoint|acp-client|transparent-routing)/i.test(path)), "legacy model/agent-loop source leaked into the tarball");

  const project = join(temp, "consumer");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(project);
  run(npm, ["init", "--yes"], { cwd: project, env: isolatedEnv });
  const tarball = join(temp, pack.filename);
  run(npm, ["install", "--omit=dev", tarball,
    "@earendil-works/pi-coding-agent@0.84.4", "@earendil-works/pi-ai@0.84.4", "typebox@1.3.25"], { cwd: project, env: isolatedEnv });

  const installed = join(project, "node_modules", "prime-agent-dsh");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/index.ts"], skills: ["./skills"] });
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
