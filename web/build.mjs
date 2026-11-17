import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["src/main.tsx"],
  bundle: true,
  jsx: "automatic",
  format: "esm",
  target: "es2022",
  outdir: "dist/assets",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info"
});
await mkdir(new URL("dist", import.meta.url), { recursive: true });
const html = (await readFile(new URL("index.html", import.meta.url), "utf8"))
  .replace("/src/main.tsx", "/assets/main.js")
  .replace("</head>", '  <link rel="stylesheet" href="/assets/main.css">\n  </head>');
await writeFile(new URL("dist/index.html", import.meta.url), html);
