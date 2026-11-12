-- OBX 0.2 (spec protocol.md 5.9.1): recycled and organic content are flags of a fibre, not fibres.
-- Products stored by 0.1 with the documented 0.1 keys get the fibre with its flag, so the database
-- holds what a 0.2 write stores. Other recycled_<fibre> / organic_<fibre> keys are normalised when
-- they are read and on the next write. Article data added in 0.2 lives in the stored JSON document,
-- so no new columns are needed.
UPDATE products SET stored =
  REPLACE(REPLACE(REPLACE(REPLACE(stored,
    '"fiber":"recycled_polyester"', '"fiber":"polyester","recycled":true'),
    '"fiber":"recycled_polyamide"', '"fiber":"polyamide","recycled":true'),
    '"fiber":"recycled_cotton"', '"fiber":"cotton","recycled":true'),
    '"fiber":"organic_cotton"', '"fiber":"cotton","organic":true')
  WHERE instr(stored, '"fiber":"recycled_') > 0 OR instr(stored, '"fiber":"organic_') > 0;
