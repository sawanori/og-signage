/** Inspect the independently built private Worker, including its import boundary. */
import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";

const directory = resolve(process.argv[2] ?? "dist-research");
const meta = JSON.parse(readFileSync(resolve(directory, "meta.json"), "utf8")) as {
  inputs: Record<string, unknown>;
  outputs: Record<string, { entryPoint?: string }>;
};
const project = resolve(import.meta.dirname, "..");
const expectedEntry = resolve(project, "research/worker.ts");
const entries = Object.values(meta.outputs).flatMap((entry) => entry.entryPoint ? [entry.entryPoint] : []);
const base = [project, resolve(project, "research"), directory, dirname(directory)]
  .find((candidate) => entries.some((entry) => resolve(candidate, entry) === expectedEntry));
if (!base) throw new Error("Cannot resolve research metafile paths to the expected private Worker");
const forbidden = new Set(["db/schema.ts", "db/index.ts", "lib/runtime.ts", "lib/config-builder.ts"]);
const inputs = Object.keys(meta.inputs).map((name) => relative(project, resolve(base, name)).replaceAll("\\", "/"));
for (const input of inputs) {
  if (forbidden.has(input) || input.startsWith("components/") || input.startsWith("app/")) {
    throw new Error(`Research Worker imports signage-only code: ${input}`);
  }
}
const bundles = Object.keys(meta.outputs).filter((name) => name.endsWith(".js"));
if (!bundles.length || !inputs.some((name) => name.endsWith("research/worker.ts"))) {
  throw new Error("Independent research Worker bundle is missing");
}
for (const name of bundles) {
  const path = existsSync(resolve(base, name)) ? resolve(base, name) : resolve(directory, name.split("/").at(-1)!);
  const content = readFileSync(path, "utf8");
  if (/LLM\|[0-9]+\||MEDIA_BUCKET|TURSO_AUTH_TOKEN|TURSO_DATABASE_URL/.test(content)) {
    throw new Error("Research bundle contains a credential or signage-only binding");
  }
  if (/[A-Za-z_$][\w$]*\((["'`])(?:node:)?(?:fs|fs\/promises|child_process|worker_threads)\1\)/.test(content)) {
    throw new Error("Research bundle contains a Node-only runtime dependency");
  }
}
console.log(`OK: private research Worker built separately (${inputs.length} inputs), with no signage DB/media imports or literal API key`);
