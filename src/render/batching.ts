export type LineGeometry = Array<{ x: number; y: number }>;

export type MergedBuffer = {
  vertices: Float32Array;
  indices: Uint32Array;
  drawCalls: number;
};

export function mergeLinesToBuffer(lines: LineGeometry[]): MergedBuffer {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const line of lines) {
    if (line.length < 2) continue;
    totalVerts += line.length;
    totalIndices += (line.length - 1) * 2;
  }
  const vertices = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;
  for (const line of lines) {
    if (line.length < 2) continue;
    for (const pt of line) {
      vertices[vOffset++] = pt.x;
      vertices[vOffset++] = pt.y;
    }
    const base = (vOffset / 2) - line.length;
    for (let i = 0; i < line.length - 1; i++) {
      indices[iOffset++] = base + i;
      indices[iOffset++] = base + i + 1;
    }
  }

  return { vertices, indices, drawCalls: lines.length };
}
