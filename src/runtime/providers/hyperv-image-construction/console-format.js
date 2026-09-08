const SIZES = new Set(['320x240', '640x480', '1024x768']);

export function consoleDimensions(width = 320, height = 240) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !SIZES.has(`${width}x${height}`)) {
    throw new TypeError('Hyper-V console dimensions are unsupported');
  }
  return Object.freeze({ width, height, rawBytes: width * height * 2 });
}
