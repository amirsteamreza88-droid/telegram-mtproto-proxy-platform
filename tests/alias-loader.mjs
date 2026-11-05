// ESM resolve hook so tests can import src/ modules directly under plain node
// (handles the "@/..." tsconfig alias and extensionless relative imports).
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

export async function resolve(specifier, context, next) {
  let p = null;
  if (specifier.startsWith("@/")) {
    p = path.join(SRC, specifier.slice(2));
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const cand = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    if (!path.extname(specifier)) p = cand;
  }
  if (p) {
    if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.ts");
    else if (!existsSync(p) && existsSync(p + ".ts")) p = p + ".ts";
    if (existsSync(p)) return { url: pathToFileURL(p).href, shortCircuit: true };
  }
  return next(specifier, context);
}
