const path = require("path");
const { PackageDatabase } = require("./lib/package-database");
const { syncEagleCatalog } = require("./lib/eagle-sync");

const projectRoot = path.resolve(__dirname, "..");
const databasePath = path.resolve(
  process.env.LARK_BOT_PACKAGING_DB || path.join(projectRoot, "data", "packaging.sqlite")
);
const aliasesPath = path.resolve(
  process.env.LARK_BOT_PACKAGE_ALIASES || path.join(projectRoot, "config", "project-aliases.json")
);

async function main() {
  const database = new PackageDatabase(databasePath);
  try {
    const report = await syncEagleCatalog(database, {
      baseUrl: process.env.EAGLE_API_BASE_URL,
      aliasesPath,
      libraryPath: process.env.LARK_BOT_EAGLE_LIBRARY_PATH,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.errors.length > 0) process.exitCode = 2;
  } finally {
    database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
