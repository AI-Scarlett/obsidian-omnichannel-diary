import esbuild from "esbuild";
import { builtinModules } from "node:module";

const banner = `/*
Omnichannel Diary 0.3.0
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
