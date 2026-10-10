// Copyright 2021-2026 ONDEWO GmbH
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

// RELEASE CREDENTIALS REACH EVERY PROCESS THROUGH THE ENVIRONMENT, NEVER THROUGH ITS ARGV.
//
// `/proc/<pid>/cmdline` (and `ps`) is world-readable, so a token on the command line of docker, npm, make or
// `/bin/sh -c` is visible to every user on the release host for the life of the process. make expands `$(NAME)`
// and `${NAME}` INTO a recipe line before the shell runs it, so a recipe reads a credential as `$${NAME}`, which
// the shell expands from the exported environment.
//
//   node --test tests/releaseCredentials.spec.js

'use strict';

const { test: runTestCase } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Find the repository root: the closest ancestor directory holding the Makefile.
 *
 * @param {string} start
 *   The directory to start from.
 * @returns {string}
 *   The repository root.
 */
function findRepoRoot(start) {
	let dir = start;
	while (!fs.existsSync(path.join(dir, 'Makefile'))) {
		dir = path.dirname(dir);
	}
	return dir;
}

/** The repository root. */
const REPO_ROOT = findRepoRoot(__dirname);

/** The Makefile holding the release recipes. */
const MAKEFILE = fs.readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8');

/** The recipe lines (make hands every tab-indented line to `/bin/sh -c`). */
const RECIPE_LINES = MAKEFILE.split('\n').filter((line) => line.startsWith('\t'));

/** A variable name that holds a credential. */
const SECRET_NAME = '[A-Z0-9_]*(?:TOKEN|PASSWORD|USERNAME|SECRET|API_KEY)[A-Z0-9_]*';

/** The GitHub workflows, if any. */
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * Cut the text of one make target: from its rule line to the next blank line.
 *
 * @param {string} target
 *   The target name.
 * @returns {string}
 *   The rule line and its recipe.
 */
function recipeOf(target) {
	const start = MAKEFILE.indexOf(`\n${target}:`);
	assert.ok(start >= 0, `the Makefile has no ${target} target`);
	return MAKEFILE.slice(start + 1).split('\n\n')[0];
}

runTestCase('make never expands a credential into a recipe line', () => {
	// `$(if $(NAME),<set>,<unset>)` only renders whether NAME is set; `$$` is the shell's own expansion.
	const expanded = new RegExp(`(?<!\\$)\\$[({]${SECRET_NAME}[)}]`);
	const leaking = RECIPE_LINES.filter((line) =>
		expanded.test(line.replace(new RegExp(`\\$\\(if \\$[({]${SECRET_NAME}[)}],`, 'g'), ''))
	);
	assert.deepEqual(leaking, []);
});

runTestCase('docker run forwards the credentials by name only', () => {
	assert.equal(new RegExp(`(?:-e|--env)[\\s=]+${SECRET_NAME}=`).exec(MAKEFILE), null);
	assert.match(recipeOf('release_to_github_via_docker_image'), /-e GITHUB_GH_TOKEN \\/);
	assert.match(recipeOf('publish_npm_via_docker'), /-e NPM_AUTOMATION_TOKEN \\/);
});

runTestCase('npm reads its token from the environment through .npmrc, never from its argv', () => {
	assert.equal((MAKEFILE.match(/_authToken/g) ?? []).length, 1);
	assert.ok(MAKEFILE.includes("npm config set '//registry.npmjs.org/:_authToken' '$${NPM_AUTOMATION_TOKEN}'"));
});

runTestCase('the devops release hands the credentials to the sub-make through its environment', () => {
	const recipe = recipeOf('run_release_with_devops');
	assert.ok(!recipe.includes('$(info)'));
	assert.ok(!recipe.includes('$(shell'));
	assert.ok(recipe.includes('set -a'));
	assert.ok(recipe.includes("grep -h -E '^(GITHUB_GH_TOKEN|NPM_AUTOMATION_TOKEN)='"));
	assert.match(recipe, /\$\(MAKE\) release$/);
	assert.equal(/\bmake\b[^\n]*\$\(info\)/.exec(MAKEFILE), null);
	assert.equal(new RegExp(`(?:\\bmake|\\$\\(MAKE\\))[^\\n]*\\b${SECRET_NAME}=`).exec(RECIPE_LINES.join('\n')), null);
});

runTestCase('no workflow interpolates a secret into a run line', () => {
	const files = fs.existsSync(WORKFLOWS_DIR) ? fs.readdirSync(WORKFLOWS_DIR) : [];
	const leaking = files.flatMap((file) =>
		fs
			.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')
			.split('\n')
			.filter((line) => line.includes('secrets.'))
			.filter((line) => !/^\s*[\w-]+:\s*\$\{\{\s*secrets\.\w+\s*\}\}\s*$/.test(line))
			.map((line) => `${file}: ${line.trim()}`)
	);
	assert.deepEqual(leaking, []);
});
