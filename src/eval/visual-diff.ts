import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface VisualDiffOptions {
  pixelThreshold?: number;
  maxMeanAbsoluteError?: number;
  maxChangedPixelRatio?: number;
}

export interface DiffBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualDiffResult {
  pass: boolean;
  width: number;
  height: number;
  candidateWidth: number;
  candidateHeight: number;
  differentDimensions: boolean;
  meanAbsoluteError: number;
  changedPixelRatio: number;
  exactPixelRatio: number;
  maxChannelError: number;
  similarity: number;
  changedBounds: DiffBounds | null;
}

const PNG_SIGNATURE = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
]);

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!
  ) >>> 0;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]!);
  }
  return value;
}

function assertAvailable(bytes: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error("Invalid PNG: truncated chunk");
  }
}

function paeth(a: number, b: number, c: number): number {
  const estimate = a + b - c;
  const distanceA = Math.abs(estimate - a);
  const distanceB = Math.abs(estimate - b);
  const distanceC = Math.abs(estimate - c);
  if (distanceA <= distanceB && distanceA <= distanceC) return a;
  if (distanceB <= distanceC) return b;
  return c;
}

function unfilterRow(
  filterType: number,
  source: Uint8Array,
  previous: Uint8Array,
  bytesPerPixel: number,
): Uint8Array {
  const row = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel]! : 0;
    const above = previous[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel]! : 0;
    const value = source[index]!;
    switch (filterType) {
      case 0:
        row[index] = value;
        break;
      case 1:
        row[index] = (value + left) & 0xff;
        break;
      case 2:
        row[index] = (value + above) & 0xff;
        break;
      case 3:
        row[index] = (value + Math.floor((left + above) / 2)) & 0xff;
        break;
      case 4:
        row[index] = (value + paeth(left, above, upperLeft)) & 0xff;
        break;
      default:
        throw new Error(`Invalid PNG: unsupported filter ${filterType}`);
    }
  }
  return row;
}

export function decodePng(input: Uint8Array): RgbaImage {
  assertAvailable(input, 0, PNG_SIGNATURE.length);
  if (!PNG_SIGNATURE.every((value, index) => input[index] === value)) {
    throw new Error("Invalid PNG: signature mismatch");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];

  while (offset < input.length) {
    assertAvailable(input, offset, 12);
    const length = readUint32(input, offset);
    const type = readAscii(input, offset + 4, 4);
    const dataOffset = offset + 8;
    assertAvailable(input, dataOffset, length + 4);
    const data = input.slice(dataOffset, dataOffset + length);
    offset = dataOffset + length + 4;

    if (type === "IHDR") {
      if (length !== 13) throw new Error("Invalid PNG: malformed IHDR");
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("Invalid PNG: unsupported compression, filter, or interlace method");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height || !idat.length) throw new Error("Invalid PNG: missing image data");
  if (bitDepth !== 8) throw new Error("Unsupported PNG: only 8-bit images are supported");
  const bytesPerPixel = {
    0: 1,
    2: 3,
    4: 2,
    6: 4,
  }[colorType];
  if (!bytesPerPixel) throw new Error(`Unsupported PNG color type ${colorType}`);

  const compressed = Buffer.concat(idat.map((chunk) => Buffer.from(chunk)));
  const inflated = inflateSync(compressed);
  const rowLength = width * bytesPerPixel;
  const expectedLength = (rowLength + 1) * height;
  if (inflated.length < expectedLength) throw new Error("Invalid PNG: incomplete scanlines");

  const pixels = new Uint8Array(width * height * 4);
  let sourceOffset = 0;
  const previous = new Uint8Array(rowLength);
  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[sourceOffset]!;
    sourceOffset += 1;
    const source = inflated.subarray(sourceOffset, sourceOffset + rowLength);
    sourceOffset += rowLength;
    const row = unfilterRow(filterType, source, previous, bytesPerPixel);
    previous.set(row);
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = x * bytesPerPixel;
      const targetIndex = (y * width + x) * 4;
      if (colorType === 6) {
        pixels[targetIndex] = row[sourceIndex]!;
        pixels[targetIndex + 1] = row[sourceIndex + 1]!;
        pixels[targetIndex + 2] = row[sourceIndex + 2]!;
        pixels[targetIndex + 3] = row[sourceIndex + 3]!;
      } else if (colorType === 2) {
        pixels[targetIndex] = row[sourceIndex]!;
        pixels[targetIndex + 1] = row[sourceIndex + 1]!;
        pixels[targetIndex + 2] = row[sourceIndex + 2]!;
        pixels[targetIndex + 3] = 255;
      } else if (colorType === 4) {
        const gray = row[sourceIndex]!;
        pixels[targetIndex] = gray;
        pixels[targetIndex + 1] = gray;
        pixels[targetIndex + 2] = gray;
        pixels[targetIndex + 3] = row[sourceIndex + 1]!;
      } else {
        const gray = row[sourceIndex]!;
        pixels[targetIndex] = gray;
        pixels[targetIndex + 1] = gray;
        pixels[targetIndex + 2] = gray;
        pixels[targetIndex + 3] = 255;
      }
    }
  }
  return { width, height, pixels };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const result = new Uint8Array(12 + data.length);
  result[0] = (data.length >>> 24) & 0xff;
  result[1] = (data.length >>> 16) & 0xff;
  result[2] = (data.length >>> 8) & 0xff;
  result[3] = data.length & 0xff;
  result.set(body, 4);
  const checksum = crc32(body);
  const checksumOffset = 8 + data.length;
  result[checksumOffset] = (checksum >>> 24) & 0xff;
  result[checksumOffset + 1] = (checksum >>> 16) & 0xff;
  result[checksumOffset + 2] = (checksum >>> 8) & 0xff;
  result[checksumOffset + 3] = checksum & 0xff;
  return result;
}

export function encodePng(image: RgbaImage): Buffer {
  if (image.width <= 0 || image.height <= 0 || image.pixels.length !== image.width * image.height * 4) {
    throw new Error("Cannot encode an invalid RGBA image");
  }
  const header = new Uint8Array(13);
  header[0] = (image.width >>> 24) & 0xff;
  header[1] = (image.width >>> 16) & 0xff;
  header[2] = (image.width >>> 8) & 0xff;
  header[3] = image.width & 0xff;
  header[4] = (image.height >>> 24) & 0xff;
  header[5] = (image.height >>> 16) & 0xff;
  header[6] = (image.height >>> 8) & 0xff;
  header[7] = image.height & 0xff;
  header[8] = 8;
  header[9] = 6;
  const scanlines = new Uint8Array((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowOffset = y * (image.width * 4 + 1);
    scanlines[rowOffset] = 0;
    scanlines.set(image.pixels.subarray(y * image.width * 4, (y + 1) * image.width * 4), rowOffset + 1);
  }
  const compressed = deflateSync(scanlines);
  const signature = PNG_SIGNATURE;
  const chunks = [pngChunk("IHDR", header), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array())];
  const totalLength = signature.length + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  output.set(signature, 0);
  let offset = signature.length;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return Buffer.from(output);
}

function compositedChannel(pixels: Uint8Array, offset: number, channel: number): number {
  const alpha = pixels[offset + 3]! / 255;
  return pixels[offset + channel]! * alpha + 255 * (1 - alpha);
}

export function comparePngBuffers(
  referenceBuffer: Uint8Array,
  candidateBuffer: Uint8Array,
  options: VisualDiffOptions = {},
): VisualDiffResult {
  const reference = decodePng(referenceBuffer);
  const candidate = decodePng(candidateBuffer);
  const differentDimensions = reference.width !== candidate.width || reference.height !== candidate.height;
  if (differentDimensions) {
    return {
      pass: false,
      width: reference.width,
      height: reference.height,
      candidateWidth: candidate.width,
      candidateHeight: candidate.height,
      differentDimensions: true,
      meanAbsoluteError: 1,
      changedPixelRatio: 1,
      exactPixelRatio: 0,
      maxChannelError: 1,
      similarity: 0,
      changedBounds: null,
    };
  }

  const pixelThreshold = Math.max(0, Math.min(1, options.pixelThreshold ?? 0.05));
  const maxMeanAbsoluteError = Math.max(0, Math.min(1, options.maxMeanAbsoluteError ?? 0.02));
  const maxChangedPixelRatio = Math.max(0, Math.min(1, options.maxChangedPixelRatio ?? 0.05));
  const pixelCount = reference.width * reference.height;
  let totalError = 0;
  let changedPixels = 0;
  let exactPixels = 0;
  let maxChannelError = 0;
  let minX = reference.width;
  let minY = reference.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < reference.height; y += 1) {
    for (let x = 0; x < reference.width; x += 1) {
      const offset = (y * reference.width + x) * 4;
      let pixelMaxError = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const referenceValue = compositedChannel(reference.pixels, offset, channel);
        const candidateValue = compositedChannel(candidate.pixels, offset, channel);
        const error = Math.abs(referenceValue - candidateValue) / 255;
        totalError += error;
        pixelMaxError = Math.max(pixelMaxError, error);
        maxChannelError = Math.max(maxChannelError, error);
      }
      if (pixelMaxError <= Number.EPSILON) exactPixels += 1;
      if (pixelMaxError > pixelThreshold) {
        changedPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const meanAbsoluteError = pixelCount ? totalError / (pixelCount * 3) : 0;
  const changedPixelRatio = pixelCount ? changedPixels / pixelCount : 0;
  const exactPixelRatio = pixelCount ? exactPixels / pixelCount : 1;
  const changedBounds = maxX >= 0 && maxY >= 0
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;
  return {
    pass: meanAbsoluteError <= maxMeanAbsoluteError && changedPixelRatio <= maxChangedPixelRatio,
    width: reference.width,
    height: reference.height,
    candidateWidth: candidate.width,
    candidateHeight: candidate.height,
    differentDimensions: false,
    meanAbsoluteError,
    changedPixelRatio,
    exactPixelRatio,
    maxChannelError,
    similarity: Math.max(0, 1 - meanAbsoluteError),
    changedBounds,
  };
}
