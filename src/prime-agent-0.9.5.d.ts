import "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionContext {
    setTimeout(callback: () => void | Promise<void>, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout> | undefined): void;
    setInterval(callback: () => void | Promise<void>, ms: number): ReturnType<typeof setInterval>;
    clearInterval(handle: ReturnType<typeof setInterval> | undefined): void;
  }
}
