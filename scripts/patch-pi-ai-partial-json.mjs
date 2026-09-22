import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
const target = join(dirname(entry), "utils", "json-parse.js");
const bare = 'from "partial-json"';
const relative = 'from "../../../../partial-json/dist/index.js"';
const source = await readFile(target, "utf8");
if (source.includes(relative)) process.exit(0);
if (!source.includes(bare)) {
  throw new Error(`Cannot apply Prime Bun compatibility patch: unexpected ${target}`);
}
await writeFile(target, source.replace(bare, relative));
