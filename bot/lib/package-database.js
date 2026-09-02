const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeBatchPath(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

function hydrateBatch(row, details = []) {
  if (!row) return null;
  return {
    ...row,
    details: details.map((detail) => ({ ...detail })),
  };
}

function hydratePackage(row) {
  if (!row) return null;
  return {
    ...row,
    aliases: jsonArray(row.aliases_json),
    tags: jsonArray(row.tags_json),
  };
}

class PackageDatabase {
  constructor(databasePath, options = {}) {
    this.databasePath = path.resolve(databasePath);
    this.migrationsDir = path.resolve(
      options.migrationsDir || path.join(__dirname, "..", "..", "migrations")
    );
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = new Set(
      this.db.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name)
    );
    const files = fs
      .readdirSync(this.migrationsDir)
      .filter((name) => /^\d+.*\.sql$/i.test(name))
      .sort();

    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = fs.readFileSync(path.join(this.migrationsDir, name), "utf8");
      this.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)")
          .run(name, Date.now());
      });
    }
  }

  transaction(task) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = task();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceCatalog(projects, packages) {
    const now = Date.now();
    const upsertProject = this.db.prepare(`
      INSERT INTO projects(
        project_id, project_name, normalized_name, aliases_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        project_name = excluded.project_name,
        normalized_name = excluded.normalized_name,
        aliases_json = excluded.aliases_json,
        status = 'active',
        updated_at = excluded.updated_at
    `);
    const upsertPackage = this.db.prepare(`
      INSERT INTO packages(
        package_id, project_id, package_name, package_type, tags_json, version,
        base_package_id, preview_eagle_id, source_eagle_id, preview_path, source_path,
        ae_comp_name, dependency_status, status, eagle_modified_at, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET
        project_id = excluded.project_id,
        package_name = excluded.package_name,
        package_type = excluded.package_type,
        tags_json = excluded.tags_json,
        version = excluded.version,
        base_package_id = excluded.base_package_id,
        preview_eagle_id = excluded.preview_eagle_id,
        source_eagle_id = excluded.source_eagle_id,
        preview_path = excluded.preview_path,
        source_path = excluded.source_path,
        ae_comp_name = excluded.ae_comp_name,
        dependency_status = excluded.dependency_status,
        status = excluded.status,
        eagle_modified_at = excluded.eagle_modified_at,
        synced_at = excluded.synced_at
    `);

    this.transaction(() => {
      this.db.prepare("UPDATE projects SET status = 'archived', updated_at = ?").run(now);
      this.db.prepare("UPDATE packages SET status = 'archived', synced_at = ?").run(now);

      for (const project of projects) {
        upsertProject.run(
          project.project_id,
          project.project_name,
          project.normalized_name,
          JSON.stringify(project.aliases || []),
          now,
          now
        );
      }

      for (const item of packages) {
        upsertPackage.run(
          item.package_id,
          item.project_id,
          item.package_name,
          item.package_type,
          JSON.stringify(item.tags || []),
          item.version,
          item.base_package_id || null,
          item.preview_eagle_id,
          item.source_eagle_id,
          item.preview_path,
          item.source_path,
          item.ae_comp_name || "",
          item.dependency_status || "complete",
          item.status || "active",
          item.eagle_modified_at || 0,
          now
        );
      }
    });
  }

  listActivePackages() {
    return this.db
      .prepare(`
        SELECT p.*, pr.project_name, pr.normalized_name, pr.aliases_json
        FROM packages p
        JOIN projects pr ON pr.project_id = p.project_id
        WHERE p.status = 'active' AND pr.status = 'active'
      `)
      .all()
      .map(hydratePackage);
  }

  activePackageCount() {
    return Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM packages WHERE status = 'active'").get().count
    );
  }

  listBatches(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.batchId) {
      clauses.push("batch_id = ?");
      params.push(String(filters.batchId));
    }
    if (filters.batchKey) {
      clauses.push("batch_key = ?");
      params.push(String(filters.batchKey));
    }
    if (filters.sourcePath) {
      clauses.push("source_path_key = ?");
      params.push(normalizeBatchPath(filters.sourcePath));
    }
    if (filters.manifestKey) {
      clauses.push("manifest_key = ?");
      params.push(String(filters.manifestKey));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM batches ${where} ORDER BY updated_at DESC, batch_id`)
      .all(...params);
    const detailStatement = this.db.prepare(
      "SELECT * FROM batch_details WHERE batch_id = ? ORDER BY package_id"
    );
    return rows.map((row) => hydrateBatch(row, detailStatement.all(row.batch_id)));
  }

  findBatch(filters = {}) {
    return this.listBatches(filters)[0] || null;
  }

  getBatch(batchId) {
    return this.findBatch({ batchId });
  }

  recordBatchImport(batch, details = [], options = {}) {
    const batchId = String(batch?.batchId || batch?.batch_id || "").trim();
    if (!batchId) throw new Error("batch_id is required");
    const mode = String(
      options.mode || batch?.importMode || batch?.import_mode || "new"
    ).trim();
    if (!["reuse", "update", "new"].includes(mode)) {
      throw new Error(`invalid batch import mode: ${mode}`);
    }
    const status = String(
      options.status || batch?.status || (mode === "update" ? "updated" : "imported")
    ).trim();
    const now = Number(options.now || Date.now());
    const sourcePath = String(batch?.sourceDir || batch?.sourcePath || batch?.source_path || "");
    const sourcePathKey = normalizeBatchPath(
      batch?.sourcePathKey || batch?.source_path_key || sourcePath
    );
    const upsertBatch = this.db.prepare(`
      INSERT INTO batches(
        batch_id, project_name, source_path, source_path_key, batch_key, manifest_key,
        batch_folder_id, import_mode, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        project_name = excluded.project_name,
        source_path = excluded.source_path,
        source_path_key = excluded.source_path_key,
        batch_key = excluded.batch_key,
        manifest_key = excluded.manifest_key,
        batch_folder_id = excluded.batch_folder_id,
        import_mode = excluded.import_mode,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);
    const upsertDetail = this.db.prepare(`
      INSERT INTO batch_details(
        batch_id, package_id, package_name, package_type, version, ae_comp_name,
        preview_path, source_path, manifest_path, preview_eagle_id, source_eagle_id,
        package_key, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id, package_id) DO UPDATE SET
        package_name = excluded.package_name,
        package_type = excluded.package_type,
        version = excluded.version,
        ae_comp_name = excluded.ae_comp_name,
        preview_path = excluded.preview_path,
        source_path = excluded.source_path,
        manifest_path = excluded.manifest_path,
        preview_eagle_id = excluded.preview_eagle_id,
        source_eagle_id = excluded.source_eagle_id,
        package_key = excluded.package_key,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);

    this.transaction(() => {
      upsertBatch.run(
        batchId,
        String(batch?.projectName || batch?.project_name || "未命名项目"),
        sourcePath,
        sourcePathKey,
        String(batch?.batchKey || batch?.batch_key || ""),
        String(batch?.manifestKey || batch?.manifest_key || ""),
        batch?.batchFolderId || batch?.batch_folder_id || null,
        mode,
        status,
        now,
        now
      );
      for (const detail of details || []) {
        const packageId = String(detail?.packageId || detail?.package_id || "").trim();
        if (!packageId) throw new Error("batch detail package_id is required");
        upsertDetail.run(
          batchId,
          packageId,
          String(detail?.packageName || detail?.package_name || ""),
          String(detail?.packageType || detail?.package_type || ""),
          String(detail?.version || "v01"),
          String(detail?.aeCompName || detail?.ae_comp_name || ""),
          String(detail?.previewPath || detail?.preview_path || ""),
          String(detail?.sourcePath || detail?.source_path || ""),
          String(detail?.manifestPath || detail?.manifest_path || ""),
          detail?.previewEagleId || detail?.preview_eagle_id || null,
          detail?.sourceEagleId || detail?.source_eagle_id || null,
          String(detail?.packageKey || detail?.package_key || ""),
          String(detail?.status || (mode === "update" ? "updated" : "imported")),
          now,
          now
        );
      }
    });
    return this.getBatch(batchId);
  }

  markBatchStatus(batchId, status, now = Date.now()) {
    this.db
      .prepare("UPDATE batches SET status = ?, updated_at = ? WHERE batch_id = ?")
      .run(String(status), now, String(batchId));
    return this.getBatch(batchId);
  }

  getPackage(packageId) {
    return hydratePackage(
      this.db
        .prepare(`
          SELECT p.*, pr.project_name, pr.normalized_name, pr.aliases_json
          FROM packages p
          JOIN projects pr ON pr.project_id = p.project_id
          WHERE p.package_id = ?
        `)
        .get(packageId)
    );
  }

  createPreparingQuery(query, candidates) {
    const insertQuery = this.db.prepare(`
      INSERT INTO queries(
        request_id, requester_id, chat_id, root_message_id, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, 'preparing', ?, ?)
    `);
    const insertCandidate = this.db.prepare(`
      INSERT INTO query_candidates(request_id, position, package_id)
      VALUES (?, ?, ?)
    `);

    this.transaction(() => {
      insertQuery.run(
        query.request_id,
        query.requester_id,
        query.chat_id,
        query.root_message_id,
        query.created_at,
        query.expires_at
      );
      candidates.forEach((candidate, index) => {
        insertCandidate.run(query.request_id, index + 1, candidate.package_id);
      });
    });
  }

  getQueryByRootMessage(rootMessageId) {
    return this.db.prepare("SELECT * FROM queries WHERE root_message_id = ?").get(rootMessageId);
  }

  setCandidatePreviewMessage(requestId, position, messageId) {
    this.db
      .prepare(`
        UPDATE query_candidates
        SET preview_message_id = ?
        WHERE request_id = ? AND position = ?
      `)
      .run(messageId, requestId, position);
  }

  markQueryPending(requestId, promptMessageId) {
    this.db
      .prepare(`
        UPDATE queries
        SET prompt_message_id = ?, status = 'pending', last_error = NULL
        WHERE request_id = ? AND status = 'preparing'
      `)
      .run(promptMessageId, requestId);
  }

  markQueryFailed(requestId, errorMessage) {
    this.db
      .prepare("UPDATE queries SET status = 'failed', last_error = ? WHERE request_id = ?")
      .run(String(errorMessage || "").slice(0, 1000), requestId);
  }

  findQueryByReplyMessage(chatId, replyMessageId) {
    const query = this.db
      .prepare(`
        SELECT q.*,
          CASE
            WHEN q.prompt_message_id = ? THEN NULL
            WHEN (
              SELECT COUNT(*)
              FROM query_candidates qc2
              WHERE qc2.request_id = q.request_id
            ) > 1 THEN NULL
            ELSE qc.position
          END AS replied_position
        FROM queries q
        LEFT JOIN query_candidates qc
          ON qc.request_id = q.request_id AND qc.preview_message_id = ?
        WHERE q.chat_id = ?
          AND (q.prompt_message_id = ? OR qc.preview_message_id = ?)
        ORDER BY q.created_at DESC
        LIMIT 1
      `)
      .get(
        replyMessageId,
        replyMessageId,
        chatId,
        replyMessageId,
        replyMessageId
      );
    if (!query) return null;
    return this.getQueryWithCandidates(query.request_id, query.replied_position);
  }

  getQueryWithCandidates(requestId, repliedPosition = null) {
    const query = this.db
      .prepare("SELECT * FROM queries WHERE request_id = ?")
      .get(requestId);
    if (!query) return null;
    const candidates = this.db
      .prepare(`
        SELECT qc.position, qc.preview_message_id, p.*, pr.project_name,
          pr.normalized_name, pr.aliases_json
        FROM query_candidates qc
        JOIN packages p ON p.package_id = qc.package_id
        JOIN projects pr ON pr.project_id = p.project_id
        WHERE qc.request_id = ?
        ORDER BY qc.position
      `)
      .all(requestId)
      .map(hydratePackage);
    return { ...query, replied_position: repliedPosition, candidates };
  }

  cancelQuery(requestId) {
    this.db
      .prepare("UPDATE queries SET status = 'cancelled' WHERE request_id = ? AND status = 'pending'")
      .run(requestId);
  }

  expireQuery(requestId) {
    this.db
      .prepare("UPDATE queries SET status = 'expired' WHERE request_id = ? AND status = 'pending'")
      .run(requestId);
  }

  claimDelivery(requestId, packageId, idempotencyKey, now = Date.now()) {
    return this.transaction(() => {
      const query = this.db.prepare("SELECT * FROM queries WHERE request_id = ?").get(requestId);
      if (!query) return { state: "missing" };
      if (query.status === "completed") {
        return { state: "completed", source_message_id: query.source_message_id };
      }
      if (query.status === "sending") return { state: "sending" };
      if (["preparing", "failed", "cancelled"].includes(query.status)) {
        return { state: query.status };
      }
      if (query.expires_at <= now) {
        this.db.prepare("UPDATE queries SET status = 'expired' WHERE request_id = ?").run(requestId);
        return { state: "expired" };
      }

      const existing = this.db
        .prepare(`
          SELECT status, source_message_id
          FROM deliveries
          WHERE request_id = ? AND package_id = ?
        `)
        .get(requestId, packageId);
      if (existing?.status === "completed") {
        return { state: "completed", source_message_id: existing.source_message_id };
      }
      if (existing?.status === "sending") return { state: "sending" };

      this.db
        .prepare(`
          INSERT INTO deliveries(
            request_id, package_id, idempotency_key, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'sending', ?, ?)
          ON CONFLICT(request_id, package_id) DO UPDATE SET
            status = CASE
              WHEN deliveries.status = 'completed' THEN 'completed'
              ELSE 'sending'
            END,
            updated_at = excluded.updated_at
        `)
        .run(requestId, packageId, idempotencyKey, now, now);
      return { state: "claimed", query };
    });
  }

  markDeliveryCompleted(requestId, packageId, sourceMessageId, now = Date.now()) {
    this.transaction(() => {
      this.db
        .prepare(`
          UPDATE deliveries
          SET status = 'completed', source_message_id = ?, updated_at = ?
          WHERE request_id = ? AND package_id = ?
        `)
        .run(sourceMessageId, now, requestId, packageId);
    });
  }

  markDeliveryFailed(requestId, packageId, errorMessage, now = Date.now()) {
    this.transaction(() => {
      this.db
        .prepare(`
          UPDATE deliveries
          SET status = 'failed', updated_at = ?
          WHERE request_id = ? AND package_id = ?
        `)
        .run(now, requestId, packageId);
    });
  }
}

module.exports = {
  PackageDatabase,
  hydrateBatch,
  hydratePackage,
  normalizeBatchPath,
};
