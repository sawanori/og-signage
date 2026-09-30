import type { MediaBucket, R2Multipart, R2PutOptions } from "../../lib/r2";

/** putの条件はオブジェクト書き込みと同時に判定する。0バイトも存在するキーとして扱う。 */
export class SpotlightBucket implements MediaBucket {
  objects = new Map<string, Uint8Array>();
  putCalls: { key: string; size: number; options?: R2PutOptions }[] = [];
  failKeys = new Set<string>();

  async put(key: string, value: Uint8Array, options?: R2PutOptions) {
    this.putCalls.push({ key, size: value.length, options });
    if (this.failKeys.has(key)) throw new Error("R2 unavailable");
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    this.objects.set(key, value.slice());
    return { size: value.length, httpEtag: `"${key}"` };
  }

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? { size: value.length, httpEtag: `"${key}"` } : null;
  }

  async get(key: string) {
    const value = this.objects.get(key)?.slice();
    return value ? { size: value.length, httpEtag: `"${key}"`, body: new Response(value).body!, arrayBuffer: async () => value.buffer } : null;
  }

  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.objects.delete(key);
  }

  async createMultipartUpload(): Promise<R2Multipart> { throw new Error("Not used by submissions"); }
  resumeMultipartUpload(): R2Multipart { throw new Error("Not used by submissions"); }
}
