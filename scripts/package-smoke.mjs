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
  "docs/inference-context-plan.md", "docs/model-wrapper-poc.md", "docs/shadow-telemetry-validation.md",
  "dsh/README.md", "dsh/acp-route.patch.yml", "dsh/cordis.patch.yml", "dsh/package.json", "dsh/provider.js", "dsh/tool.js",
  "extensions/index.ts", "extensions/shadow-context.ts", "scripts/package-smoke.mjs", "skills/deepseek-harness/SKILL.md",
  "src/acp-client.ts", "src/compaction.ts", "src/config.ts", "src/context-converter.ts", "src/context-protocol.ts",
  "src/dsh-agent-pool.ts", "src/dsh-capabilities.ts", "src/dsh-context-service.ts", "src/dsh-image-attachments.ts",
  "src/dsh-provider-catalog.ts", "src/dsh-provider-config.ts", "src/dsh-provider-host.ts", "src/dsh-provider-security.ts",
  "src/dsh-provider-turn-reasons.ts", "src/dsh-provider-types.ts", "src/dsh-provider.ts", "src/model-route.ts",
  "src/notifications.ts", "src/prefix-metrics.ts", "src/prime-user-questions.ts", "src/runtime-manager.ts",
  "src/shadow-telemetry.ts", "src/transparent-provider.ts",
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

  const project = join(temp, "consumer");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(project);
  run(npm, ["init", "--yes"], { cwd: project, env: isolatedEnv });
  const tarball = join(temp, pack.filename);
  run(npm, ["install", "--omit=dev", "--ignore-scripts", tarball,
    "@earendil-works/pi-coding-agent@0.84.4", "@earendil-works/pi-ai@0.84.4", "typebox@1.3.25"], { cwd: project, env: isolatedEnv });

  const installed = join(project, "node_modules", "prime-agent-dsh");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/index.ts"], skills: ["./skills"] });

  const host = await import(pathToFileURL(join(project, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")));
  const settingsManager = host.SettingsManager.inMemory({ packages: [installed] }, { projectTrusted: true });
  const loader = new host.DefaultResourceLoader({ cwd: project, agentDir: join(temp, "home", ".prime", "agent"), settingsManager, noContextFiles: true });
  await loader.reload();
  let extensions = loader.getExtensions();
  let skills = loader.getSkills();
  assert.equal(extensions.errors.length, 0, JSON.stringify(extensions.errors));
  assert.equal(extensions.extensions.length, 1, "Prime did not discover exactly one package extension");
  assert(extensions.extensions[0].tools.has("deepseek_harness"), "package extension did not register deepseek_harness");
  assert(skills.skills.some(({ name }) => name === "deepseek-harness"), "Prime did not discover the deepseek-harness skill");
  assert.equal(skills.diagnostics.length, 0, JSON.stringify(skills.diagnostics));
  const shutdownHandlers = extensions.extensions[0].handlers.get("session_shutdown") ?? [];
  assert(shutdownHandlers.length > 0, "extension did not register session_shutdown cleanup");
  for (const handler of shutdownHandlers) await handler({}, {});

  await loader.reload();
  extensions = loader.getExtensions();
  skills = loader.getSkills();
  assert.equal(extensions.errors.length, 0, "extension reload produced an error");
  assert.equal(extensions.extensions.length, 1, "extension was not retained across reload");
  assert(skills.skills.some(({ name }) => name === "deepseek-harness"), "skill was not retained across reload");
  console.log(`package smoke passed: ${actual.length} files; production install; extension + skill discovery; reload`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
