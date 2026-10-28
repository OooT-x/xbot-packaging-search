const fs = require("fs");
const path = require("path");

// Keep machine-specific NAS paths outside Git and share them across both entry points.
function configuredLibraryPath(fallback = "", options = {}) {
  const env = options.env || process.env;
  const override = String(env.LARK_BOT_EAGLE_LIBRARY_PATH || "").trim();
  if (override) return override;
  const configFile = options.configFile || path.resolve(__dirname, "../../config/eagle-library.local.json");
  if (!fs.existsSync(configFile)) return fallback;
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (typeof config.libraryPath !== "string" || !config.libraryPath.trim()) {
    throw new Error(`Invalid Eagle libraryPath in ${configFile}`);
  }
  return config.libraryPath.trim();
}

module.exports = { configuredLibraryPath };
