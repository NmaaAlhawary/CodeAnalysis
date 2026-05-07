const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
};

if (watch) {
  esbuild.context(options).then((ctx) => {
    ctx.watch();
    console.log("Watching for changes…");
  });
} else {
  esbuild.build(options).then(() => {
    console.log("Build complete → out/extension.js");
  }).catch(() => process.exit(1));
}
