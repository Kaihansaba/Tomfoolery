declare module '*.json' {
  const value: any;
  export default value;
}

declare module './ctm_engine' {
  export * from '../ctm_engine';
}
