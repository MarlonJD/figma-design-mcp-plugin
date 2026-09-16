import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface PngLimits {
  maxInputBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
  maxInflatedBytes?: number;
}

export interface VisualComparisonMetadata {
  captureId?: string;
  scale?: number;
  cropOrigin?: { x: number; y: number };
  cropWidth?: number;
  cropHeight?: number;
}

export interface RegionThreshold {
  pixelThreshold?: number;
  maxMeanAbsoluteError?: number;
  maxChangedPixelRatio?: number;
}

export interface VisualDiffOptions extends PngLimits {
  pixelThreshold?: number;
  maxMeanAbsoluteError?: number;
  maxChangedPixelRatio?: number;
  regionColumns?: number;
  regionRows?: number;
  regionThresholds?: Record<string, RegionThreshold>;
  referenceMetadata?: VisualComparisonMetadata;
  candidateMetadata?: VisualComparisonMetadata;
  compositingBackground?: [number, number, number];
}

export interface DiffBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffRegion extends DiffBounds {
  meanAbsoluteError: number;
  changedPixelRatio: number;
  similarity: number;
  pass: boolean;
}

export interface VisualDiffResult {
  comparatorVersion: "designport-png-v2";
  compositingPolicy: "over-solid-background";
  compositingBackground: [number, number, number];
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
  regions: DiffRegion[];
}

const PNG_SIGNATURE = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
]);
const DEFAULT_PNG_LIMITS: Required<PngLimits> = {
  maxInputBytes: 50_000_000,
  maxWidth: 20_000,
  maxHeight: 20_000,
  maxPixels: 100_000_000,
  maxInflatedBytes: 400_000_000,
};

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
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index]!);
  return value;
}

function assertAvailable(bytes: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset > bytes.length - length) {
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
      case 0: row[index] = value; break;
      case 1: row[index] = (value + left) & 0xff; break;
      case 2: row[index] = (value + above) & 0xff; break;
      case 3: row[index] = (value + Math.floor((left + above) / 2)) & 0xff; break;
      case 4: row[index] = (value + paeth(left, above, upperLeft)) & 0xff; break;
      default: throw new Error(`Invalid PNG: unsupported filter ${filterType}`);
    }
  }
  return row;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function limitsFor(options?: PngLimits): Required<PngLimits> {
  const limits = {
    ...DEFAULT_PNG_LIMITS,
    ...(options?.maxInputBytes !== undefined ? { maxInputBytes: options.maxInputBytes } : {}),
    ...(options?.maxWidth !== undefined ? { maxWidth: options.maxWidth } : {}),
    ...(options?.maxHeight !== undefined ? { maxHeight: options.maxHeight } : {}),
    ...(options?.maxPixels !== undefined ? { maxPixels: options.maxPixels } : {}),
    ...(options?.maxInflatedBytes !== undefined ? { maxInflatedBytes: options.maxInflatedBytes } : {}),
  };
  if (Object.values(limits).some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error("Invalid PNG limits");
  }
  return limits;
}

function assertWithinLimit(value: number, limit: number, message: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > limit) throw new Error(message);
}

export function decodePng(input: Uint8Array, options?: PngLimits): RgbaImage {
  const limits = limitsFor(options);
  assertWithinLimit(input.byteLength, limits.maxInputBytes, "Invalid PNG: input exceeds the byte limit");
  assertAvailable(input, 0, PNG_SIGNATURE.length);
  if (!PNG_SIGNATURE.every((value, index) => input[index] === value)) throw new Error("Invalid PNG: signature mismatch");

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let sawHeader = false;
  let sawEnd = false;
  const idat: Uint8Array[] = [];
  while (offset < input.length) {
    assertAvailable(input, offset, 12);
    const length = readUint32(input, offset);
    const type = readAscii(input, offset + 4, 4);
    const dataOffset = offset + 8;
    assertAvailable(input, dataOffset, length + 4);
    const data = input.slice(dataOffset, dataOffset + length);
    const actualCrc = readUint32(input, dataOffset + length);
    const checksumBody = new Uint8Array(4 + length);
    checksumBody.set(input.subarray(offset + 4, offset + 8), 0);
    checksumBody.set(data, 4);
    if (crc32(checksumBody) !== actualCrc) throw new Error(`Invalid PNG: CRC mismatch in ${type}`);
    offset = dataOffset + length + 4;

    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw new Error("Invalid PNG: malformed IHDR");
      sawHeader = true;
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("Invalid PNG: unsupported compression, filter, or interlace method");
      }
      assertWithinLimit(width, limits.maxWidth, "Unsupported PNG: width exceeds the limit");
      assertWithinLimit(height, limits.maxHeight, "Unsupported PNG: height exceeds the limit");
      assertWithinLimit(width * height, limits.maxPixels, "Unsupported PNG: pixel count exceeds the limit");
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) throw new Error("Invalid PNG: misplaced IDAT");
      idat.push(data);
    } else if (type === "IEND") {
      if (!sawHeader || sawEnd || length !== 0) throw new Error("Invalid PNG: malformed IEND");
      sawEnd = true;
    }
    if (sawEnd) break;
  }

  if (!sawHeader || !sawEnd || offset !== input.length) throw new Error("Invalid PNG: missing or trailing data");
  if (!width || !height || !idat.length) throw new Error("Invalid PNG: missing image data");
  if (bitDepth !== 8) throw new Error("Unsupported PNG: only 8-bit images are supported");
  const bytesPerPixel = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!bytesPerPixel) throw new Error(`Unsupported PNG color type ${colorType}`);
  const rowLength = width * bytesPerPixel;
  const expectedLength = (rowLength + 1) * height;
  assertWithinLimit(expectedLength, limits.maxInflatedBytes, "Unsupported PNG: decompressed data exceeds the limit");
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))), {
      maxOutputLength: expectedLength,
    });
  } catch (error) {
    throw new Error(`Invalid PNG: decompression failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (inflated.length !== expectedLength) throw new Error("Invalid PNG: scanline length mismatch");

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
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width <= 0 || image.height <= 0
    || image.pixels.length !== image.width * image.height * 4) {
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
    scanlines.set(image.pixels.subarray(y * image.width * 4, (y + 1) * image.width * 4), rowOffset + 1);
  }
  const chunks = [pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", new Uint8Array())];
  const output = new Uint8Array(PNG_SIGNATURE.length + chunks.reduce((total, chunk) => total + chunk.length, 0));
  output.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return Buffer.from(output);
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function compositedChannel(
  pixels: Uint8Array,
  offset: number,
  channel: number,
  background: [number, number, number],
): number {
  const alpha = pixels[offset + 3]! / 255;
  return pixels[offset + channel]! * alpha + background[channel]! * (1 - alpha);
}

function regionCount(value: number | undefined, maximum: number): number {
  const requested = Number.isFinite(value) ? Math.floor(value as number) : 8;
  return Math.max(1, Math.min(maximum, 32, requested));
}

function boundaries(size: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, index) => Math.floor((index * size) / count));
}

function regionIndex(value: number, edges: number[]): number {
  let low = 0;
  let high = edges.length - 2;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (value < edges[middle]!) {
      high = middle - 1;
    } else if (value >= edges[middle + 1]!) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return edges.length - 2;
}

function boundedThreshold(value: number | undefined, fallback: number): number {
  return clampUnit(Number.isFinite(value) ? value as number : fallback);
}

function assertCaptureMetadata(options: VisualDiffOptions): void {
  const reference = options.referenceMetadata;
  const candidate = options.candidateMetadata;
  if (!reference || !candidate) return;
  if (reference.scale !== undefined && candidate.scale !== undefined && reference.scale !== candidate.scale) {
    throw new Error("Visual capture scale metadata does not match");
  }
  if (reference.cropOrigin && candidate.cropOrigin
    && (reference.cropOrigin.x !== candidate.cropOrigin.x || reference.cropOrigin.y !== candidate.cropOrigin.y)) {
    throw new Error("Visual capture crop origin metadata does not match");
  }
  if (reference.cropWidth !== candidate.cropWidth || reference.cropHeight !== candidate.cropHeight) {
    if (reference.cropWidth !== undefined || candidate.cropWidth !== undefined
      || reference.cropHeight !== undefined || candidate.cropHeight !== undefined) {
      throw new Error("Visual capture crop dimensions metadata does not match");
    }
  }
}

export function comparePngBuffers(
  referenceBuffer: Uint8Array,
  candidateBuffer: Uint8Array,
  options: VisualDiffOptions = {},
): VisualDiffResult {
  assertCaptureMetadata(options);
  const reference = decodePng(referenceBuffer, options);
  const candidate = decodePng(candidateBuffer, options);
  const background = options.compositingBackground ?? [255, 255, 255];
  if (!background.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)) {
    throw new Error("Compositing background must contain RGB bytes");
  }
  const differentDimensions = reference.width !== candidate.width || reference.height !== candidate.height;
  const baseResult = {
    comparatorVersion: "designport-png-v2" as const,
    compositingPolicy: "over-solid-background" as const,
    compositingBackground: background,
  };
  if (differentDimensions) {
    return {
      ...baseResult,
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
      regions: [],
    };
  }

  const pixelThreshold = boundedThreshold(options.pixelThreshold, 0.05);
  const maxMeanAbsoluteError = boundedThreshold(options.maxMeanAbsoluteError, 0.02);
  const maxChangedPixelRatio = boundedThreshold(options.maxChangedPixelRatio, 0.05);
  const regionColumns = regionCount(options.regionColumns, reference.width);
  const regionRows = regionCount(options.regionRows, reference.height);
  const xEdges = boundaries(reference.width, regionColumns);
  const yEdges = boundaries(reference.height, regionRows);
  const regionStats = Array.from({ length: regionColumns * regionRows }, () => ({ error: 0, pixels: 0, changed: 0 }));
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
      const regionColumn = regionIndex(x, xEdges);
      const regionRow = regionIndex(y, yEdges);
      const region = regionStats[regionRow * regionColumns + regionColumn]!;
      region.pixels += 1;
      let pixelMaxError = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const referenceValue = compositedChannel(reference.pixels, offset, channel, background);
        const candidateValue = compositedChannel(candidate.pixels, offset, channel, background);
        const error = Math.abs(referenceValue - candidateValue) / 255;
        totalError += error;
        region.error += error;
        pixelMaxError = Math.max(pixelMaxError, error);
        maxChannelError = Math.max(maxChannelError, error);
      }
      if (pixelMaxError <= Number.EPSILON) exactPixels += 1;
      if (pixelMaxError > pixelThreshold) {
        changedPixels += 1;
        region.changed += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const meanAbsoluteError = totalError / (pixelCount * 3);
  const changedPixelRatio = changedPixels / pixelCount;
  const exactPixelRatio = exactPixels / pixelCount;
  const changedBounds = maxX >= 0 && maxY >= 0
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;
  const regions = regionStats.map((stats, index) => {
    const column = index % regionColumns;
    const row = Math.floor(index / regionColumns);
    const x = xEdges[column]!;
    const y = yEdges[row]!;
    const width = xEdges[column + 1]! - x;
    const height = yEdges[row + 1]! - y;
    const meanRegionError = stats.pixels ? stats.error / (stats.pixels * 3) : 0;
    const threshold = options.regionThresholds?.[`${column}x${row}`] ?? {};
    const regionMae = boundedThreshold(threshold.maxMeanAbsoluteError, maxMeanAbsoluteError);
    const regionChanged = boundedThreshold(threshold.maxChangedPixelRatio, maxChangedPixelRatio);
    return {
      x,
      y,
      width,
      height,
      meanAbsoluteError: meanRegionError,
      changedPixelRatio: stats.pixels ? stats.changed / stats.pixels : 0,
      similarity: Math.max(0, 1 - meanRegionError),
      pass: meanRegionError <= regionMae && (stats.pixels ? stats.changed / stats.pixels : 0) <= regionChanged,
    };
  });
  return {
    ...baseResult,
    pass: meanAbsoluteError <= maxMeanAbsoluteError
      && changedPixelRatio <= maxChangedPixelRatio
      && regions.every((region) => region.pass),
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
    regions,
  };
}

export function createDiffPng(
  referenceBuffer: Uint8Array,
  candidateBuffer: Uint8Array,
  kind: "heatmap" | "overlay",
  options: PngLimits = {},
): Buffer {
  const reference = decodePng(referenceBuffer, options);
  const candidate = decodePng(candidateBuffer, options);
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error("Cannot create a visual diff image for different dimensions");
  }
  const pixels = new Uint8Array(reference.pixels.length);
  const background: [number, number, number] = [255, 255, 255];
  for (let index = 0; index < reference.width * reference.height; index += 1) {
    const offset = index * 4;
    const referenceChannels = [0, 1, 2].map((channel) => compositedChannel(reference.pixels, offset, channel, background));
    const candidateChannels = [0, 1, 2].map((channel) => compositedChannel(candidate.pixels, offset, channel, background));
    if (kind === "overlay") {
      pixels[offset] = Math.round((referenceChannels[0]! + candidateChannels[0]!) / 2);
      pixels[offset + 1] = Math.round((referenceChannels[1]! + candidateChannels[1]!) / 2);
      pixels[offset + 2] = Math.round((referenceChannels[2]! + candidateChannels[2]!) / 2);
    } else {
      const error = Math.max(
        Math.abs(referenceChannels[0]! - candidateChannels[0]!),
        Math.abs(referenceChannels[1]! - candidateChannels[1]!),
        Math.abs(referenceChannels[2]! - candidateChannels[2]!),
      ) / 255;
      pixels[offset] = 255;
      pixels[offset + 1] = Math.round(255 * (1 - error));
      pixels[offset + 2] = Math.round(255 * (1 - error));
    }
    pixels[offset + 3] = 255;
  }
  return encodePng({ width: reference.width, height: reference.height, pixels });
}
