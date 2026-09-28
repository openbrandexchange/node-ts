-- Indexes found with the seeded load test (scripts/loadtest.ts, docs/performance.md):
-- admin catalog list sorted by last change, portal list by style number, colour facet counts.
CREATE INDEX IF NOT EXISTS products_modified ON products(modified_at, id);
CREATE INDEX IF NOT EXISTS products_style_id ON products(style_number COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS variants_facet ON variants(product_id, status, color_code);
