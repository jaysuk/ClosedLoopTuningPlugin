#!/usr/bin/env node
/**
 * Compile every `src/ui36/*.vue` with DuetWebControl 3.6's OWN Vue 2.7 compiler.
 *
 * Why this exists: `ui36` gets no type checking at all (see docs/PLAN-dwc36-backport.md §7.2). It is
 * excluded from the Vue 3 `vue-tsc` run by `dwcTypecheckIgnore`, and DWC 3.6 ships no `vue-tsc` of its
 * own — so until now its only automated safety net was the full webpack build, which takes ~4 minutes
 * and needs several GB of RAM it cannot always get.
 *
 * This is the cheap net underneath that: it runs in about a second and catches the errors a hand-
 * written Vue 2 template actually gets wrong — malformed markup, unclosed tags, bad interpolation
 * expressions, `<script setup>` that Vue 2.7 cannot compile.
 *
 * What it deliberately does NOT catch, so nobody mistakes a pass for a green light:
 *   - wrong Vuetify 2 prop or slot NAMES (e.g. Vuetify 4's `density` or `#append-inner` surviving the
 *     translation). Those are valid markup; only the running component knows they are wrong.
 *   - module resolution / type errors — that is the webpack build's job (build36.bat).
 * A pass here means "this will compile", not "this will render correctly".
 *
 *   DWC36_DIR=/path/to/DuetWebControl-3.6  node scripts/check-ui36.mjs
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dwcDir = process.env.DWC36_DIR;

if (!dwcDir || !existsSync(dwcDir)) {
	console.error(
		"DWC36_DIR is not set or does not exist. Point it at a DuetWebControl 3.6 checkout with\n"
		+ "dependencies installed — this borrows its Vue 2.7 compiler, which the plugin itself cannot\n"
		+ "depend on (it builds against Vue 3 for the 3.7 package).",
	);
	process.exit(2);
}

const compilerPath = join(dwcDir, "node_modules", "vue", "compiler-sfc");
if (!existsSync(compilerPath)) {
	console.error(`No Vue 2.7 compiler at ${compilerPath} — run npm install in the DWC 3.6 checkout.`);
	process.exit(2);
}

const require_ = createRequire(import.meta.url);
const sfc = require_(compilerPath);

const dir = join(repo, "src", "ui36");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".vue")) : [];
if (files.length === 0) {
	console.error(`No .vue files in ${dir}.`);
	process.exit(2);
}

let failed = 0;
for (const file of files) {
	const source = readFileSync(join(dir, file), "utf8");
	// Scoped-style id; also what compileScript/compileTemplate use to correlate their output.
	const id = `data-v-${file.replace(/\W/g, "")}`;
	try {
		// NB: Vue 2.7's parse() returns the descriptor DIRECTLY. Vue 3 wraps it as { descriptor, errors },
		// so code copied from a Vue 3 project silently reads undefined here and "fails" every file.
		const descriptor = sfc.parse({ source, filename: file });
		if (descriptor.errors?.length) {
			throw new Error(descriptor.errors.map((e) => e.msg ?? e.message ?? String(e)).join("; "));
		}
		if (descriptor.scriptSetup) {
			sfc.compileScript(descriptor, { id });
		}
		if (descriptor.template) {
			const result = sfc.compileTemplate({ source: descriptor.template.content, filename: file, id });
			if (result.errors?.length) {
				throw new Error(result.errors.map(String).join("; "));
			}
			for (const tip of result.tips ?? []) {
				console.log(`  ~    ${file}: ${tip}`);
			}
		}
		console.log(`  OK   ${file}`);
	} catch (e) {
		failed++;
		console.log(`  FAIL ${file}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

console.log(`\n${files.length - failed}/${files.length} DWC 3.6 SFCs compiled with Vue 2.7.`);
if (failed > 0) {
	process.exit(1);
}
console.log("Compiles only — Vuetify 2 prop/slot correctness still needs build36.bat and a real machine.");
