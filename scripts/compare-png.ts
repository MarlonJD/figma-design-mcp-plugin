import { readFile } from "node:fs/promises";
import { comparePngBuffers, type VisualDiffOptions } from "../src/eval/visual-diff.js";

function usage(): never {
  console.error("Usage: npm run visual:compare -- <reference.png> <candidate.png> [options]");
  console.error("Options: --pixel-threshold=0.05 --max-mae=0.02 --max-changed=0.05 --json");
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

const args = process.argv.slice(2);
const positionalArgs = args.filter((argument) => !argument.startsWith("--"));
if (positionalArgs.length < 2 || args.includes("--help") || args.includes("-h")) usage();

try {
  const options: VisualDiffOptions = {
    pixelThreshold: numberOption(args, "--pixel-threshold="),
    maxMeanAbsoluteError: numberOption(args, "--max-mae="),
    maxChangedPixelRatio: numberOption(args, "--max-changed="),
  };
  const [referencePath, candidatePath] = positionalArgs;
  const result = comparePngBuffers(
    await readFile(referencePath!),
    await readFile(candidatePath!),
    options,
  );
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
