const path = require("node:path");
const { PackageDatabase } = require("./lib/package-database");

function run(args = process.argv.slice(2)) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) throw new Error("expected named options");
    values.set(args[i], args[i + 1]?.startsWith("--") || !args[i + 1] ? true : args[++i]);
  }
  const database = new PackageDatabase(path.resolve(
    process.env.LARK_BOT_PACKAGING_DB || path.join(__dirname, "..", "data", "packaging.sqlite")
  ));
  try {
    const requestId = values.get("--request-id"), packageId = values.get("--package-id");
    if (!requestId && !packageId) {
      console.log(JSON.stringify(database.db.prepare(`SELECT d.request_id, d.package_id,
        d.phase, d.status, d.source_message_id, d.last_error, q.root_message_id, q.expires_at
        FROM deliveries d JOIN queries q USING(request_id)
        WHERE d.phase = 'uncertain' AND d.status = 'failed'`).all(), null, 2));
      return;
    }
    if (typeof requestId !== "string" || typeof packageId !== "string") {
      throw new Error("--request-id and --package-id are required");
    }
    const messageId = values.get("--verified-message-id");
    const notSent = values.get("--verified-not-sent") === true;
    if ((typeof messageId === "string") === notSent) {
      throw new Error("verify the original Feishu thread, then provide exactly one of --verified-message-id or --verified-not-sent");
    }
    database.reconcileDelivery(requestId, packageId, messageId || null);
    console.log("Reconciled; no message was sent. A retry still requires the original requester confirmation within its expiry.");
  } finally { database.close(); }
}
if (require.main === module) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { run };
