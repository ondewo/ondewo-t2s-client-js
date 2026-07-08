// Re-merges the CI test scripts + devDependencies (from .ci-package.json) back into
// package.json after the proto-compiler regenerates root package.json during the release
// build (output-volume == repo root). Keeps the generated deps/version; restores test setup.
const fs = require('fs');
if (!fs.existsSync('.ci-package.json')) { console.log('restore-ci-package: no .ci-package.json, skipping'); process.exit(0); }
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const ci = JSON.parse(fs.readFileSync('.ci-package.json', 'utf8'));
pkg.scripts = Object.assign({}, pkg.scripts || {}, ci.scripts || {});
pkg.devDependencies = Object.assign({}, pkg.devDependencies || {}, ci.devDependencies || {});
if (ci.description) pkg.description = ci.description;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('restore-ci-package: merged CI test setup; scripts=[' + Object.keys(pkg.scripts).join(',') + ']');
