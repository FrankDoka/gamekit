export type ByteRangeResult =
  | { kind: "full"; statusCode: 200; start: 0; end: number; length: number; headers: Record<string, string> }
  | { kind: "partial"; statusCode: 206; start: number; end: number; length: number; headers: Record<string, string> }
  | { kind: "unsatisfiable"; statusCode: 416; headers: Record<string, string> };

export function byteRangeFor(rangeHeader: string | undefined, size: number): ByteRangeResult {
  const baseHeaders = { "accept-ranges": "bytes" };
  if (!rangeHeader) {
    return {
      kind: "full",
      statusCode: 200,
      start: 0,
      end: Math.max(0, size - 1),
      length: size,
      headers: { ...baseHeaders, "content-length": String(size) },
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size <= 0) {
    return {
      kind: "unsatisfiable",
      statusCode: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${size}` },
    };
  }

  const rawStart = match[1];
  const rawEnd = match[2];
  let start: number;
  let end: number;
  if (rawStart === "" && rawEnd === "") {
    return { kind: "unsatisfiable", statusCode: 416, headers: { ...baseHeaders, "content-range": `bytes */${size}` } };
  }
  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { kind: "unsatisfiable", statusCode: 416, headers: { ...baseHeaders, "content-range": `bytes */${size}` } };
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return { kind: "unsatisfiable", statusCode: 416, headers: { ...baseHeaders, "content-range": `bytes */${size}` } };
  }
  end = Math.min(end, size - 1);
  return {
    kind: "partial",
    statusCode: 206,
    start,
    end,
    length: end - start + 1,
    headers: {
      ...baseHeaders,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    },
  };
}
