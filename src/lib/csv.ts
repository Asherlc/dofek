export type DecodeCsvResult =
  | { ok: true; rows: Array<{ fields: string[]; rowNumber: number }> }
  | { ok: false; rowNumber: number | null; message: string };

export function decodeCsv(csvText: string): DecodeCsvResult {
  const text = csvText.replace(/^\uFEFF/, "");
  const rows: Array<{ fields: string[]; rowNumber: number }> = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowNumber = 1;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (character === "\n") {
      row.push(field);
      rows.push({ fields: row, rowNumber });
      row = [];
      field = "";
      rowNumber++;
      continue;
    }

    if (character === "\r") {
      continue;
    }

    field += character;
  }

  if (inQuotes) {
    return { ok: false, rowNumber, message: `row ${rowNumber}: malformed CSV row` };
  }

  row.push(field);
  rows.push({ fields: row, rowNumber });

  return {
    ok: true,
    rows: rows.filter((row) => row.fields.some((value) => value.trim() !== "")),
  };
}
