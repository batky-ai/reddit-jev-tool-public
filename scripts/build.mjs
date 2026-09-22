// Bundles the extension into dist/, which is the folder loaded unpacked in Chrome.
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const out = "dist";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp("static", out, { recursive: true });

const options = {
  entryPoints: {
    content: "src/content/index.ts",
    background: "src/background/index.ts",
    options: "src/options/index.ts",
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: out,
  sourcemap: "linked",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
