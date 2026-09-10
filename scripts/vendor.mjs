/* Copies marked's ESM build into the dashboard's public dir. public/ has no
   bundler — the build step is `cp -R` — so the browser needs the file on disk
   next to the app's own modules, and it is committed. Run after bumping marked. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// marked's package exports hide lib/, so resolve the manifest and walk from it.
const require = createRequire(import.meta.url);
const manifest = require.resolve("marked/package.json");
const { version } = require(manifest);
// The .map is not shipped; the pragma pointing at it would 404 in devtools.
const source = readFileSync(join(dirname(manifest), "lib/marked.esm.js"), "utf8").replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n");
const header = `/* marked ${version} — vendored: public/ ships as-is, no bundler. Regenerate with \`npm run vendor\`. */\n`;

mkdirSync("src/dashboard/public/vendor", { recursive: true });
writeFileSync("src/dashboard/public/vendor/marked.esm.js", header + source);
console.log(`vendored marked ${version}`);
