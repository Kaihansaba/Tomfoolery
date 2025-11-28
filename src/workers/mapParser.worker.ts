/// <reference lib="webworker" />
import { parseMapIndexData } from '../utils/mapLoader.js';

self.onmessage = async (event: MessageEvent) => {
  const { url } = event.data as { url: string };
  try {
    const resp = await fetch(url);
    const text = await resp.text(); // fallback: full text, parsing in worker avoids main-thread stall
    const json = JSON.parse(text);
    const index = parseMapIndexData(json);
    (self as unknown as Worker).postMessage({ ok: true, index });
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ ok: false, error: err?.message ?? String(err) });
  }
};
