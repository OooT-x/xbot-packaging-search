ALTER TABLE queries ADD COLUMN search_type TEXT NOT NULL DEFAULT '';
ALTER TABLE queries ADD COLUMN seen_package_ids_json TEXT NOT NULL DEFAULT '[]';
