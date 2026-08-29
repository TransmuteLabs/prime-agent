#!/usr/bin/env node
/**
 * Release script for pi-mono
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *   node scripts/release.mjs <target> --dry-run   (preview changelog updates only)
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Verify every public workspace package is registered on npm
 * 3. Bump version via npm run version:xxx or set an explicit version
 * 4. Update CHANGELOG.md files: aggregate .changes/*.md fragments into a
 *    [version] - date section, git rm the consumed fragments
 * 5. Regenerate release artifacts
 * 6. Run checks and tests
 * 7. Commit and tag the release
 * 8. Publish to npm
 * 9. Push main and the tag
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildReleaseSection } from "./lib/changelog-fragments.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const RELEASE_TARGET = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z> [--dry-run]");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function assertPackagesAreRegisteredWithNpm() {
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	const unregisteredPackages = [];

	console.log("Checking npm package registration...");
	for (const packageName of packageNames) {
		const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["view", packageName, "version", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (result.status === 0 && result.stdout.trim()) {
			console.log(`  ${packageName}`);
			continue;
		}

		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			unregisteredPackages.push(packageName);
			continue;
		}

		throw new Error(output ? `Failed to query npm registration for ${packageName}\n${output}` : `Failed to query npm registration for ${packageName}`);
	}

	if (unregisteredPackages.length > 0) {
		throw new Error(`The following public workspace packages are not registered on npm:\n${unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n")}\nRegister them before running a release.`);
	}

	console.log("  All public workspace packages are registered on npm\n");
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(
		getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]),
	);
	const lockPath = "package-lock.json";
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		console.log(`Removed ${removed} stale workspace package lock ${removed === 1 ? "entry" : "entries"}.`);
	}
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
			process.exit(1);
		}

		console.log(`Setting explicit version (${target})...`);
		run(`npm version ${target} --workspaces --no-git-tag-version --no-workspaces-update && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`);
	}

	// npm version can temporarily install the previous workspace versions before
	// sync-versions updates inter-package ranges. Remove those stale lock entries,
	// refresh the lockfile, then hydrate from the final dependency graph.
	removeStaleWorkspaceLockEntries();
	run("npm install --package-lock-only --ignore-scripts");
	run("npm ci --ignore-scripts");
	return getVersion();
}

function getChangelogs() {
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function listFragments(pkgDir) {
	const changesDir = join(pkgDir, ".changes");
	if (!existsSync(changesDir)) {
		return [];
	}

	const files = readdirSync(changesDir)
		.filter((name) => name.endsWith(".md") && name !== "README.md")
		.map((name) => join(changesDir, name));
	return files
		.map((path) => ({ path, key: fragmentSortKey(path) }))
		.sort((a, b) => a.key - b.key || (a.path < b.path ? -1 : 1))
		.map(({ path }) => ({ name: path, content: readFileSync(path, "utf-8") }));
}

function fragmentSortKey(path) {
	const output = run(`git log --diff-filter=A --format=%ct -1 -- ${shellQuote(path)}`, {
		silent: true,
		ignoreError: true,
	});
	const epoch = Number.parseInt((output || "").trim(), 10);
	return Number.isFinite(epoch) ? epoch : Infinity;
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();
	const consumedFragments = [];

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");
		const allFragments = listFragments(dirname(changelog));
		// Empty fragments are skipped, not consumed, so nothing is ever lost silently.
		const empty = allFragments.filter((fragment) => !fragment.content.trim());
		for (const fragment of empty) {
			console.warn(`  Warning: skipping empty fragment ${fragment.name}; delete it or add content.`);
		}
		const fragments = allFragments.filter((fragment) => fragment.content.trim());
		const result = buildReleaseSection(content, fragments, version, date);

		if (!result.changed) {
			console.log(`  Skipping ${changelog}: no fragments`);
			continue;
		}

		if (DRY_RUN) {
			console.log(`\n--- ${changelog} (${fragments.length} fragments) ---`);
			const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const sectionRe = new RegExp(`## \\[${escapedVersion}\\][\\s\\S]*?(?=\\n## \\[|$)`);
			console.log((result.content.match(sectionRe) || ["(no release section)"])[0]);
		} else {
			writeFileSync(changelog, result.content);
			console.log(`  Updated ${changelog} (${fragments.length} fragments)`);
		}
		consumedFragments.push(...fragments.map((fragment) => fragment.name));
	}

	if (consumedFragments.length > 0) {
		if (DRY_RUN) {
			console.log(`\nWould git rm: ${consumedFragments.join(", ")}`);
		} else {
			run(`git rm -q -- ${consumedFragments.map(shellQuote).join(" ")}`);
		}
	}
}

function previewVersion(target) {
	if (!BUMP_TYPES.has(target)) {
		return target;
	}
	const [major, minor, patch] = getVersion().split(".").map(Number);
	if (target === "major") return `${major + 1}.0.0`;
	if (target === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

console.log("\n=== Release Script ===\n");

if (DRY_RUN) {
	const version = previewVersion(RELEASE_TARGET);
	console.log(`Dry run for v${version}: previewing changelog updates, no files are written.`);
	updateChangelogsForRelease(version);
	console.log("\n=== Dry run complete (no changes made) ===");
	process.exit(0);
}

console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Verify npm package registration before modifying the worktree.
assertPackagesAreRegisteredWithNpm();

// 3. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 4. Fold .changes fragments into the release section
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 5. Regenerate release artifacts
console.log("Regenerating release artifacts...");
run("npm run generate:models");
run("npm run check:model-data");
run("npm run shrinkwrap:coding-agent");
run("npm run install-lock:coding-agent");
console.log();

// 6. Run checks and tests
console.log("Running checks...");
run("npm run check");
console.log();

console.log("Building packages for tests...");
run("npm run build:offline");
console.log();

console.log("Running tests...");
run("./test.sh");
console.log();

// 7. Commit and tag
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 8. Publish
// No CI publish workflow exists here, so the release script publishes directly.
console.log("Publishing to npm...");
run("npm run publish");
console.log();

// 9. Push
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Prepared release v${version}; CI publication and pi.dev announcement start after the tag push ===`);
