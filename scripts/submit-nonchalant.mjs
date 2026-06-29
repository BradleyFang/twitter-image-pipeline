#!/usr/bin/env node

import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function printUsage() {
  console.log(`Usage: npm run submit:nonchalant -- [--fresh|--cached] [--limit <count>]

Options:
  --fresh          fetch a fresh Twitter/X image batch before submitting
  --cached         submit the cached Twitter/X image batch only
  --limit <count>  submit at most this many photo images

Environment:
  NONCHALANT_API_URL        defaults to http://localhost:3001
  NONCHALANT_CLIENT_ID      required
  NONCHALANT_CLIENT_SECRET  required

Twitter/X env vars are the same ones used by the app when a fresh fetch is needed.`);
}

async function getImages(mode) {
  const { fetchFreshTwitterImages, getCachedTwitterImages } = await import(
    "../lib/twitter-images.ts"
  );

  if (mode !== "fresh") {
    const cached = await getCachedTwitterImages();

    if (cached.images.length > 0 || mode === "cached") {
      return {
        images: cached.images,
        source: "cached",
        warning: cached.error,
      };
    }
  }

  let lastReadyCount = 0;
  const fresh = await fetchFreshTwitterImages(async ({ readyCount }) => {
    if (readyCount !== lastReadyCount) {
      lastReadyCount = readyCount;
      console.log(`Fetched ${readyCount} usable image(s)...`);
    }
  });

  return {
    images: fresh.images,
    source: "fresh",
    warning: fresh.error,
  };
}

function formatErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return "none";
  }

  return JSON.stringify(errors, null, 2);
}

function getMediaTypeCounts(images) {
  return images.reduce((counts, image) => {
    const mediaType = image.mediaType || "missing";
    counts[mediaType] = (counts[mediaType] || 0) + 1;

    return counts;
  }, {});
}

function parsePositiveInteger(value, optionName) {
  if (!/^\d+$/.test(value || "")) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

function parseArgs(argv) {
  const flags = new Set();
  let limit;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--limit") {
      index += 1;

      if (index >= argv.length) {
        throw new Error("--limit requires a count.");
      }

      limit = parsePositiveInteger(argv[index], "--limit");
      continue;
    }

    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInteger(arg.slice("--limit=".length), "--limit");
      continue;
    }

    flags.add(arg);
  }

  return {
    flags,
    limit,
  };
}

async function main() {
  const { flags: args, limit } = parseArgs(process.argv.slice(2));

  if (args.has("--help") || args.has("-h")) {
    printUsage();
    return;
  }

  const mode = args.has("--fresh")
    ? "fresh"
    : args.has("--cached")
      ? "cached"
      : "auto";

  const nonchalant = await import("../lib/nonchalant.ts");
  const config = nonchalant.getNonchalantConfigFromEnv();
  const { images, source, warning } = await getImages(mode);

  if (images.length === 0) {
    throw new Error(
      warning ||
        "No Twitter/X images were available to submit to nonchalant.",
    );
  }

  if (warning) {
    console.warn(`Image batch warning: ${warning}`);
  }

  const photoImages = images.filter((image) => image.mediaType === "photo");
  const imagesToSubmit = limit ? photoImages.slice(0, limit) : photoImages;
  const skippedNonPhotoCount = images.length - photoImages.length;

  if (imagesToSubmit.length === 0) {
    throw new Error(
      `No photo media were available to submit to nonchalant. Media type counts: ${JSON.stringify(
        getMediaTypeCounts(images),
      )}`,
    );
  }

  if (skippedNonPhotoCount > 0) {
    console.log(
      `Skipping ${skippedNonPhotoCount} non-photo media item(s): ${JSON.stringify(
        getMediaTypeCounts(images),
      )}`,
    );
  }

  if (limit && photoImages.length > imagesToSubmit.length) {
    console.log(
      `Limiting submission to ${imagesToSubmit.length} of ${photoImages.length} photo image(s).`,
    );
  }

  console.log(
    `Submitting ${imagesToSubmit.length} ${source} Twitter/X photo image(s) to ${config.apiUrl}...`,
  );

  const { request, response } = await nonchalant.submitImagesToNonchalant(
    config,
    imagesToSubmit,
  );

  console.log("\nNonchalant batch submitted");
  console.log(`imageSetSlug: ${request.imageSetSlug}`);
  console.log(`studySlug: ${request.studySlug}`);
  console.log(`studyImageSetId: ${response.studyImageSetId}`);
  console.log(`studyId: ${response.studyId}`);
  console.log(`humorFlavorId: ${response.humorFlavorId}`);
  console.log(`uploaded image count: ${response.uploadedImages?.length ?? 0}`);
  console.log(`caption count: ${response.captionIds?.length ?? 0}`);
  console.log(`errors: ${formatErrors(response.errors)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
