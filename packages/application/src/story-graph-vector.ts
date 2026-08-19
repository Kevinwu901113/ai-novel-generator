/**
 * 图检索的向量工具（D14 / B23，D-B23-2）。
 *
 * 机制刻意选最笨的一档：float32 BLOB + JS 暴力余弦。单项目图规模 ≤ 1e4 行，
 * ANN 没有收益，而 sqlite-vec 会把原生扩展依赖引进本地优先的部署里；
 * 规模真的顶上来再换（决策里已登记为可复议）。
 *
 * 序列化固定小端：跨机器搬项目目录时字节序必须是确定的，不能跟着宿主走。
 */

/** float32 小端序列化（与 story_embeddings.vector 的存储格式一一对应） */
export function serializeEmbedding(vector: ReadonlyArray<number> | Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i += 1) {
    view.setFloat32(i * 4, vector[i], true);
  }
  return bytes;
}

/** 反序列化；字节数不是 4 的整数倍视为损坏 */
export function deserializeEmbedding(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`嵌入向量字节数 ${blob.byteLength} 不是 4 的整数倍`);
  }
  const out = new Float32Array(blob.byteLength / 4);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/** 余弦相似度；任一向量为零向量返回 0（不是 NaN——下游要排序） */
export function cosineSimilarity(
  a: ReadonlyArray<number> | Float32Array,
  b: ReadonlyArray<number> | Float32Array,
): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface EmbeddingCandidate {
  readonly kind: string;
  readonly refId: string;
  readonly vector: Float32Array;
}

export interface EmbeddingMatch {
  readonly kind: string;
  readonly refId: string;
  readonly score: number;
}

/**
 * 暴力 topK。
 *
 * 维度不一致的候选直接跳过（换过嵌入模型的旧行会这样，重算前不该污染结果）；
 * 排序确定性：分数降序 → kind → refId，同分不靠 sort 的实现细节。
 */
export function cosineTopK(
  query: ReadonlyArray<number> | Float32Array,
  candidates: ReadonlyArray<EmbeddingCandidate>,
  k: number,
): ReadonlyArray<EmbeddingMatch> {
  if (k <= 0 || query.length === 0) return [];
  const scored: EmbeddingMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.vector.length !== query.length) continue;
    scored.push({
      kind: candidate.kind,
      refId: candidate.refId,
      score: cosineSimilarity(query, candidate.vector),
    });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.refId < b.refId ? -1 : 1;
  });
  return scored.slice(0, k);
}
