export const config = {
  optimizations: {
    chunkedIndex: true,
    progressiveGeometry: true,
    chunkBatching: true,
    lodZooms: {
      Z1: 0.6,
      Z2: 1.2,
    },
    chunkRadius: 2,
    chunkMargin: 1,
    prefetchNeighbors: 2,
  },
};
