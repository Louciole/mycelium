-- Per-cell formatting for spreadsheets (text/background color, alignment,
-- displayed decimal places).
-- Safe to run on an existing database; idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_spreadsheet_format.sql

ALTER TABLE note_spreadsheet_cell ADD COLUMN IF NOT EXISTS text_color varchar(9);
ALTER TABLE note_spreadsheet_cell ADD COLUMN IF NOT EXISTS bg_color varchar(9);
ALTER TABLE note_spreadsheet_cell ADD COLUMN IF NOT EXISTS align varchar(6);
ALTER TABLE note_spreadsheet_cell ADD COLUMN IF NOT EXISTS decimals smallint;
