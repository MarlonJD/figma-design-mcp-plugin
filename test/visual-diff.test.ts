import test from "node:test";
import assert from "node:assert/strict";
import {
  comparePngBuffers,
  createDiffPng,
  decodePng,
  encodePng,
  type RgbaImage,
} from "../src/eval/visual-diff.js";

function image(width: number, height: number, color: [number, number, number, number]): RgbaImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) pixels.set(color, index * 4);
  return { width, height, pixels };
}

test("visual diff passes identical PNGs", () => {
  const png = encodePng(image(2, 2, [20, 30, 40, 255]));
  const result = comparePngBuffers(png, png);
  assert.equal(result.pass, true);
  assert.equal(result.meanAbsoluteError, 0);
  assert.equal(result.changedPixelRatio, 0);
  assert.equal(result.changedBounds, null);
});

test("visual diff reports changed bounds and fails meaningful differences", () => {
  const reference = encodePng(image(4, 3, [255, 255, 255, 255]));
  const candidateImage = image(4, 3, [255, 255, 255, 255]);
  candidateImage.pixels.set([0, 0, 0, 255], (1 * 4 + 2) * 4);
  const result = comparePngBuffers(reference, encodePng(candidateImage), {
    pixelThreshold: 0.01,
    maxMeanAbsoluteError: 0,
    maxChangedPixelRatio: 0,
  });
  assert.equal(result.pass, false);
  assert.equal(result.changedPixelRatio, 1 / 12);
  assert.deepEqual(result.changedBounds, { x: 2, y: 1, width: 1, height: 1 });
  const changedRegion = result.regions.find((region) => region.x === 2 && region.y === 1);
  assert.ok(changedRegion);
  assert.equal(changedRegion.changedPixelRatio, 1);
  assert.equal(changedRegion.width, 1);
  assert.equal(changedRegion.height, 1);
});

test("visual diff rejects different viewport dimensions", () => {
  const result = comparePngBuffers(
    encodePng(image(2, 2, [0, 0, 0, 255])),
    encodePng(image(3, 2, [0, 0, 0, 255])),
  );
  assert.equal(result.pass, false);
  assert.equal(result.differentDimensions, true);
  assert.equal(result.candidateWidth, 3);
  assert.deepEqual(result.regions, []);
});

test("visual diff can emit heatmap and overlay PNG evidence", () => {
  const reference = encodePng(image(2, 2, [255, 255, 255, 255]));
  const candidateImage = image(2, 2, [255, 255, 255, 255]);
  candidateImage.pixels.set([0, 0, 0, 255], 0);
  const candidate = encodePng(candidateImage);
  const heatmap = decodePng(createDiffPng(reference, candidate, "heatmap"));
  const overlay = decodePng(createDiffPng(reference, candidate, "overlay"));
  assert.deepEqual([heatmap.width, heatmap.height], [2, 2]);
  assert.deepEqual([overlay.width, overlay.height], [2, 2]);
  assert.deepEqual([...heatmap.pixels.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...overlay.pixels.slice(0, 4)], [128, 128, 128, 255]);
});
