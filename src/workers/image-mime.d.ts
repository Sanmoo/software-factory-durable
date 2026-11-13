/** Factory composition facade: exact pinned native byte function, no file probing. */
export function detectSupportedImageMimeType(buffer: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp' | null;
