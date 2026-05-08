const fs = require("fs");
const path = require("path");

const rootDir = process.cwd();
const pkgPath = path.join(rootDir, "package.json");
const manifestPath = path.join(rootDir, "update.json"); // change this if your file name is different

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

if (!fs.existsSync(pkgPath)) {
  console.error("package.json not found.");
  process.exit(1);
}

const pkg = readJson(pkgPath);
const version = pkg.version;

const releaseTag = `v${version}`;
const fileName = `CoevasTerminalSetup-${version}.exe`;

const manifest = {
  latestVersion: version,
  minimumRequiredVersion: version,
  forceUpdate: true,
  downloadUrl: `https://github.com/COMEONSOM/openroot-web/releases/download/${releaseTag}/${fileName}`,
  title: "Update Available",
  notes: `New version (v${version}) available with automatic update system.`
};

writeJson(manifestPath, manifest);

console.log(`Update manifest written to ${manifestPath} for version ${version}`);