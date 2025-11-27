# MapParser Overpass Fetcher

This small TypeScript utility hits the Overpass API, converts the returned OpenStreetMap nodes/ways into a `NetworkJSON` structure, and writes the result to `network.json`.

## Setup

```bash
npm install
```

## Run

```bash
npm run fetch
```

The bounding box and query live inside `src/overpass.ts`. Adjust the `query` string to target a different geographic area before running the script.

## Build

If you need plain JavaScript output, run:

```bash
npm run build
```

