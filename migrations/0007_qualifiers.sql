-- OBX 0.3 (spec protocol.md 5.9.1, final): a fibre has a list of qualifiers instead of one.
-- Products stored by a pre-release 0.3 node (and by migration 0006) with {"qualifier": {"code":
-- "recycled"}} get {"qualifiers": [{"code": "recycled"}]}; a fibre without a qualifier ("qualifier":
-- null or absent) stores no "qualifiers" (the node returns []). Other members are kept.
UPDATE products SET stored = json_set(stored, '$.materials', (
  SELECT json_group_array(json(
    json_set(json(p.value), '$.fibers', (
      SELECT json_group_array(json(
        CASE WHEN json_type(f.value, '$.qualifier') = 'object'
          THEN json_set(json_remove(json(f.value), '$.qualifier'), '$.qualifiers', json_array(json(json_extract(f.value, '$.qualifier'))))
          ELSE json_remove(json(f.value), '$.qualifier') END
      ))
      FROM (SELECT value FROM json_each(p.value, '$.fibers') ORDER BY key) AS f
    ))
  ))
  FROM (SELECT value FROM json_each(stored, '$.materials') ORDER BY key) AS p
))
WHERE json_type(stored, '$.materials') = 'array' AND instr(stored, '"qualifier"') > 0;
