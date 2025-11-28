// Fallback shim for macro engine when not present in bundled build.
export type MacroNetwork = any;
export function initMacroSimulation(_macro: any) {
  // no-op
}
export function stepMacro(_dt: number) {
  // no-op
}
export function getMacroState() {
  return null;
}
export function setMacroRho(_rho: number[]) {
  // no-op
}
