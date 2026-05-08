const fs = require("fs");
const path = require("path");

const rootDir = process.cwd();
const pkgPath = path.join(rootDir, "package.json");
const lockPath = path.join(rootDir, "package-lock.json");

const bumpType = (process.argv[2] || "minor").toLowerCase();

function bumpSemver(version, type = "minor") {
  const parts = String(version || "0.0.0").split(".").map(n => parseInt(n, 10));
  let [major, minor, patch] = [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];

  if (type === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === "patch") {
    patch += 1;
  } else {
    minor += 1;
    patch = 0;
  }

  return `${major}.${minor}.${patch}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

if (!fs.existsSync(pkgPath)) {
  console.error("package.json not found in current directory.");
  process.exit(1);
}

const pkg = readJson(pkgPath);
const nextVersion = bumpSemver(pkg.version, bumpType);

pkg.version = nextVersion;

if (pkg.build && typeof pkg.build === "object") {
  pkg.build.buildVersion = nextVersion;
}

writeJson(pkgPath, pkg);

if (fs.existsSync(lockPath)) {
  try {
    const lock = readJson(lockPath);
    lock.version = nextVersion;

    if (lock.packages && lock.packages[""]) {
      lock.packages[""].version = nextVersion;
    }

    writeJson(lockPath, lock);
  } catch (err) {
    console.warn("package-lock.json update skipped:", err.message);
  }
}

console.log(`Version bumped to ${nextVersion}`);