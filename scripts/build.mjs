import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const banner = `/*
Omnichannel Diary ${manifest.version}
Generated from the independent source in src/. Do not edit this bundle directly.
*/`;

const disablePdfDynamicCode = {
  name: "disable-pdf-dynamic-code",
  setup(build) {
    build.onLoad({ filter: /pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs$/ }, async ({ path }) => {
      const original = await readFile(path, "utf8");
      const pattern = /new Function\(""\);/g;
      const matches = original.match(pattern) || [];
      if (matches.length !== 1) throw new Error(`Expected one PDF.js dynamic-code probe, found ${matches.length}`);
      return {
        contents: original.replace(pattern, 'throw new Error("Dynamic code is disabled");'),
        loader: "js",
      };
    });
  },
};

const useExplicitHttpDecoders = {
  name: "use-explicit-http-decoders",
  setup(build) {
    build.onLoad({ filter: /axios[\\/](?:lib[\\/]adapters[\\/]http\.js|dist[\\/]node[\\/]axios\.cjs)$/ }, async ({ path }) => {
      let source = await readFile(path, "utf8");
      const marker = "streams.push(zlib.createUnzip(zlibOptions));";
      const matches = source.split(marker).length - 1;
      if (matches !== 2) throw new Error(`Expected two Axios automatic decoder calls in ${path}, found ${matches}`);
      source = source.replace(marker, "streams.push(zlib.createGunzip(zlibOptions));");
      source = source.replace(marker, "streams.push(zlib.createInflate(zlibOptions));");
      source = source.replace("'gzip, compress, deflate'", "'gzip, deflate'");
      return { contents: source, loader: "js" };
    });
  },
};

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "main.js",
  banner: { js: banner },
  footer: { js: "/* nosourcemap */" },
  external: [
    "obsidian",
    "electron",
    "audio-decode",
    "jimp",
    "link-preview-js",
    "music-metadata",
    "sharp",
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  plugins: [disablePdfDynamicCode, useExplicitHttpDecoders],
  legalComments: "eof",
  minify: true,
  sourcemap: false,
  treeShaking: true,
});
