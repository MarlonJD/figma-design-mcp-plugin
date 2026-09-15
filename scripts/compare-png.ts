import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { comparePngBuffers, createDiffPng, type VisualDiffOptions } from "../src/eval/visual-diff.js";

function usage(): never {
  console.error("Usage: npm run visual:compare -- <reference.png> <candidate.png> [options]");
  console.error("Options: --pixel-threshold=0.05 --max-mae=0.02 --max-changed=0.05 --regions=8x8 --heatmap-output=diff.png --overlay-output=overlay.png --json");
  process.exit(2);
}

function numberOption(args: string[], prefix: string): number | undefined {
  const value = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${prefix} must be a number between 0 and 1`);
  }
  return parsed;
}

function regionOption(args: string[]): { regionColumns?: number; regionRows?: number } {
  const value = args.find((argument) => argument.startsWith("--regions="))?.slice("--regions=".length);
  if (value === undefined) return {};
  const match = /^(\d+)(?:x(\d+))?$/.exec(value);
  if (!match) throw new Error("--regions must be an integer or COLSxROWS between 1 and 32");
  const columns = Number(match[1]);
  const rows = Number(match[2] ?? match[1]);
  if (![columns, rows].every((item) => Number.isInteger(item) && item >= 1 && item <= 32)) {
    throw new Error("--regions must be an integer or COLSxROWS between 1 and 32");
  }
  return { regionColumns: columns, regionRows: rows };
}

function stringOption(args: string[], prefix: string): string | undefined {
  const value = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value || undefined;
}

async function writePng(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

const args = process.argv.slice(2);
const positionalArgs = args.filter((argument) => !argument.startsWith("--"));
if (positionalArgs.length < 2 || args.includes("--help") || args.includes("-h")) usage();

try {
  const options: VisualDiffOptions = {
    pixelThreshold: numberOption(args, "--pixel-threshold="),
    maxMeanAbsoluteError: numberOption(args, "--max-mae="),
    maxChangedPixelRatio: numberOption(args, "--max-changed="),
    ...regionOption(args),
  };
  const [referencePath, candidatePath] = positionalArgs;
  const referenceBuffer = await readFile(referencePath!);
  const candidateBuffer = await readFile(candidatePath!);
  const result = comparePngBuffers(
    referenceBuffer,
    candidateBuffer,
    options,
  );
  if (!result.differentDimensions) {
    const heatmapPath = stringOption(args, "--heatmap-output=") || stringOption(args, "--diff-output=");
    const overlayPath = stringOption(args, "--overlay-output=");
    if (heatmapPath) await writePng(heatmapPath, createDiffPng(referenceBuffer, candidateBuffer, "heatmap"));
    if (overlayPath) await writePng(overlayPath, createDiffPng(referenceBuffer, candidateBuffer, "overlay"));
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Visual diff: ${result.pass ? "PASS" : "FAIL"}`);
    console.log(`Similarity: ${(result.similarity * 100).toFixed(2)}%`);
    console.log(`Mean absolute error: ${(result.meanAbsoluteError * 100).toFixed(3)}%`);
    console.log(`Changed pixels: ${(result.changedPixelRatio * 100).toFixed(2)}%`);
    if (result.changedBounds) {
      const { x, y, width, height } = result.changedBounds;
      console.log(`Changed bounds: x=${x}, y=${y}, width=${width}, height=${height}`);
    }
    if (result.differentDimensions) {
      console.log(`Dimensions: reference ${result.width}x${result.height}, candidate ${result.candidateWidth}x${result.candidateHeight}`);
    }
  }
  process.exitCode = result.pass ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
