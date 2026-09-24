import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import process from "process";
import { fileURLToPath } from "node:url";

const prod = process.argv[2] === "production";
const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, "node_modules/@cursor/sdk/dist/cjs");
const sdkVendorDir = join(root, ".sdk-vendor/cjs");
rmSync(sdkVendorDir, { recursive: true, force: true });
mkdirSync(sdkVendorDir, { recursive: true });
writeFileSync(join(sdkVendorDir, "package.json"), '{"type":"commonjs"}\n');
for (const name of readdirSync(srcDir)) {
  if (!/^(index|[0-9]+)\.js$/.test(name)) continue;
  copyFileSync(join(srcDir, name), join(sdkVendorDir, name));
}

const context = await esbuild.context({
  banner: { js: "/* vault-talk — bundled */\n" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  alias: { "@cursor/sdk": join(sdkVendorDir, "index.js") },
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "bun:sqlite",
    "node:sqlite",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  format: "cjs",
  platform: "node",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
