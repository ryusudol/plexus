export {};

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        plexus?: { postMessage: (payload: unknown) => void };
      };
    };
    __toggleSessions: () => void;
    __toggleSettings: () => void;
    __closePickers: () => void;
    __syncPickerOverlay: () => void;
  }
}
