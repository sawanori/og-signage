/**
 * multipart/form-data の本文を上限つきで読む（Content-Length が無い・偽っている本文も上限で止める）。
 * 上限を超えたら tooLarge()、形式が違えば invalid() が返すエラーを投げる。
 */
export async function readLimitedFormData(request: Request, maxBytes: number, errors: { tooLarge: () => Error; invalid: () => Error }): Promise<FormData> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) throw errors.tooLarge();
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;") || !request.body) throw errors.invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw errors.tooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    return await new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: bytes }).formData();
  } catch { throw errors.invalid(); }
}
