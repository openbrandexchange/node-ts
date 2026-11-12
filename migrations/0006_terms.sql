-- OBX 0.3 (spec protocol.md 5.9.1, proposal 0004): parts, materials and qualifiers are terms.
-- Products stored by 0.2 ({"part": "lining", "fibers": [{"fiber": "polyester", "percentage": 100,
-- "recycled": true}]}) get the 0.3 stored form ({"part": {"code": "lining"}, "fibers": [{"material":
-- {"code": "polyester"}, "percentage": 100, "qualifier": {"code": "recycled"}}]}). Names, care
-- categories and symbols of known codes are not stored: the node adds them from the vocabularies when
-- it reads. Stored care entries ({"code", "text"}) are already in the 0.3 stored form.
UPDATE products SET stored = json_set(stored, '$.materials', (
  SELECT json_group_array(json(
    json_set(json(p.value),
      '$.part', json_object('code', json_extract(p.value, '$.part')),
      '$.fibers', (
        SELECT json_group_array(json(
          json_remove(
            json_set(json(f.value),
              '$.material', json_object('code', json_extract(f.value, '$.fiber')),
              '$.qualifier', json(CASE
                WHEN json_type(f.value, '$.recycled') = 'true' THEN '{"code":"recycled"}'
                WHEN json_type(f.value, '$.organic') = 'true' THEN '{"code":"organic"}'
                ELSE 'null' END)),
            '$.fiber', '$.recycled', '$.organic',
            CASE WHEN json_type(f.value, '$.recycled') = 'true' OR json_type(f.value, '$.organic') = 'true' THEN '$.x-obx-none' ELSE '$.qualifier' END)
        ))
        FROM (SELECT value FROM json_each(p.value, '$.fibers') ORDER BY key) AS f
      ))
  ))
  FROM (SELECT value FROM json_each(stored, '$.materials') ORDER BY key) AS p
))
WHERE json_type(stored, '$.materials') = 'array' AND json_type(stored, '$.materials[0].part') = 'text';
