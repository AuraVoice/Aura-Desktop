/// <reference types="vite/client" />

declare module "*.glb" {
  const src: string;
  export default src;
}

declare module "mammoth/mammoth.browser.js" {
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{
    value: string;
    messages: Array<{ type: string; message: string }>;
  }>;
}
