import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const banner = `/*
Omnichannel Diary ${manifest.version}
Generated from the independent source in src/. Do not edit this bundle directly.
*/`;

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "main.js",
  banner: { js: banner },
  external: [
    "obsidian",
    "electron",
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  legalComments: "eof",
  minify: true,
  sourcemap: false,
  treeShaking: true,
});
