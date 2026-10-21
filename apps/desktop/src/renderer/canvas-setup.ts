// Must run before Excalidraw initializes its font registry. No CDN fallback.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}
export {};
window.EXCALIDRAW_ASSET_PATH = new URL('./', window.location.href).toString();
