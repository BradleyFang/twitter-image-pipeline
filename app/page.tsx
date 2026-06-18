import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Image from "next/image";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after, connection } from "next/server";
import { createWorker } from "tesseract.js";
import { GenerationRefresh } from "./generation-refresh";

export const maxDuration = 300;

const IMAGE_LIMIT = 8;
const OCR_TEXT_CHARACTER_LIMIT = 0;
const OCR_MAX_IMAGE_BYTES = 10_000_000;
const MAX_VIDEO_OR_GIF_DURATION_MS = 10_000;
const MAX_VIDEO_OR_GIF_BYTES = 10_000_000;
const MAX_SEARCH_PAGES_PER_QUERY = 25;
const JOB_STALE_AFTER_MS = 10 * 60 * 1000;
const CACHE_FILE_PATH = path.join(
  process.cwd(),
  ".next",
  "cache",
  "twitter-images.json",
);
const ARCHIVE_FILE_PATH = path.join(
  process.cwd(),
  ".next",
  "cache",
  "twitter-image-gallery.json",
);
const JOB_FILE_PATH = path.join(
  process.cwd(),
  ".next",
  "cache",
  "twitter-image-job.json",
);
const SEARCH_CURSOR_FILE_PATH = path.join(
  process.cwd(),
  ".next",
  "cache",
  "twitter-search-cursors.json",
);
const TESSERACT_WORKER_PATH = path.join(
  process.cwd(),
  "node_modules",
  "tesseract.js",
  "src",
  "worker-script",
  "node",
  "index.js",
);
const TESSERACT_CORE_PATH = path.join(
  process.cwd(),
  "node_modules",
  "tesseract.js-core",
);
const TESSERACT_LANGUAGE_PATH = path.join(
  process.cwd(),
  "node_modules",
  "@tesseract.js-data",
  "eng",
  "4.0.0",
);
const SEARCH_ENDPOINT = "https://api.x.com/2/tweets/search/recent";
const QUERY_SUFFIX = "has:media";
const DEFAULT_IMAGE_QUERY = "has:media";
const X_API_MAX_ATTEMPTS = 4;
const X_API_RETRY_BASE_DELAY_MS = 1_000;
const X_API_RETRY_MAX_DELAY_MS = 30_000;
const X_API_RETRY_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const ENV_FILE_PATHS = [
  path.join(/*turbopackIgnore: true*/ process.cwd(), ".env"),
  path.join(/*turbopackIgnore: true*/ process.cwd(), ".env.local"),
  path.join(/*turbopackIgnore: true*/ process.cwd(), ".env.development"),
  path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    ".env.development.local",
  ),
];

type ImageSearchQuery = {
  query: string;
  label: string;
};

type TwitterMedia = {
  media_key: string;
  type?: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  variants?: TwitterMediaVariant[];
};

type TwitterMediaVariant = {
  bit_rate?: number;
  content_type?: string;
  url?: string;
};

type TwitterUser = {
  id: string;
  name?: string;
  username?: string;
};

type TwitterPost = {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  possibly_sensitive?: boolean;
  attachments?: {
    media_keys?: string[];
  };
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
  };
};

type TwitterSearchResponse = {
  data?: TwitterPost[];
  includes?: {
    media?: TwitterMedia[];
    users?: TwitterUser[];
  };
  meta?: {
    next_token?: string;
  };
  errors?: Array<{
    title?: string;
    detail?: string;
  }>;
};

type GalleryImage = {
  id: string;
  imageUrl: string;
  mediaUrl?: string;
  mediaType?: "photo" | "video" | "animated_gif";
  alt: string;
  sourceUrl: string;
  postText: string;
  authorName: string;
  username?: string;
  width: number;
  height: number;
  collectionName?: string;
  trendName?: string;
};

type TwitterImageResult = {
  images: GalleryImage[];
  error?: string;
};

type CachedTwitterImages = {
  images: GalleryImage[];
  savedAt: string;
};

type SavedImageArchive = {
  images: GalleryImage[];
  savedAt: string;
};

type SearchCursor = {
  query: string;
  label: string;
  untilId?: string;
  updatedAt: string;
};

type SearchCursorCache = {
  cursors: Record<string, SearchCursor>;
  savedAt: string;
};

type GenerationJob = {
  status: "idle" | "running" | "error";
  readyCount?: number;
  totalCount?: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
};

type ImageSearchProgress = {
  readyCount: number;
  totalCount: number;
};

type ImageSearchStats = {
  postsScanned: number;
  imageAttachmentsFound: number;
  duplicateImageUrls: number;
  ocrRejectedImages: number;
  accounts: AccountSearchStats[];
};

type AccountSearchStats = {
  label: string;
  pagesScanned: number;
  postsScanned: number;
  imageAttachmentsFound: number;
  duplicateImageUrls: number;
  ocrRejectedImages: number;
  acceptedImages: number;
  exhausted: boolean;
};

function getBearerToken() {
  return (
    process.env.TWITTER_BEARER_TOKEN ||
    process.env.TWITTER_API_BEARER_TOKEN ||
    process.env.TWITTER_API_KEY
  );
}

function getConfiguredAccountHandles() {
  const handles = new Set<string>();
  const addHandles = (value?: string) => {
    value
      ?.split(",")
      .map((handle) => handle.trim().replace(/^@/, ""))
      .filter(Boolean)
      .filter((handle) => /^[A-Za-z0-9_]{1,15}$/.test(handle))
      .forEach((handle) => handles.add(handle));
  };

  addHandles(process.env.TWITTER_IMAGE_ACCOUNTS);

  for (const filePath of ENV_FILE_PATHS) {
    if (!existsSync(filePath)) {
      continue;
    }

    for (const line of readFileSync(filePath, "utf8").split(/\n/)) {
      const match = line.match(/^\s*#?\s*TWITTER_IMAGE_ACCOUNTS\s*=\s*(.*)$/);

      if (match) {
        addHandles(match[1].split("#")[0].trim().replace(/^['"]|['"]$/g, ""));
      }
    }
  }

  return [...handles];
}

function filterImagesToKnownAccounts(images: GalleryImage[]) {
  const knownHandles = new Set(
    getConfiguredAccountHandles().map((handle) => handle.toLowerCase()),
  );

  if (knownHandles.size === 0) {
    return images;
  }

  return images.filter(
    (image) => image.username && knownHandles.has(image.username.toLowerCase()),
  );
}

function buildAccountQueries(handles: string[]): ImageSearchQuery[] {
  return handles.map((handle) => ({
    query: `from:${handle} ${QUERY_SUFFIX}`,
    label: handle,
  }));
}

async function getSearchQueries() {
  const configuredQuery = process.env.TWITTER_IMAGE_QUERY?.trim();

  if (configuredQuery) {
    return {
      queries: [
        {
          query: configuredQuery,
          label: "Custom query",
        },
      ],
    };
  }

  const handles = getConfiguredAccountHandles();
  const queries = buildAccountQueries(handles);

  if (queries.length === 0) {
    return {
      queries: [
        {
          query: DEFAULT_IMAGE_QUERY,
          label: "Recent X posts",
        },
      ],
    };
  }

  return {
    queries,
  };
}

function truncateText(text: string, maxLength = 120) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function getRetryAfterDelayMs(retryAfter: string | null) {
  if (!retryAfter) {
    return undefined;
  }

  const retryAfterSeconds = Number(retryAfter);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1_000, X_API_RETRY_MAX_DELAY_MS);
  }

  const retryAfterDate = Date.parse(retryAfter);

  if (!Number.isNaN(retryAfterDate)) {
    return Math.min(
      Math.max(0, retryAfterDate - Date.now()),
      X_API_RETRY_MAX_DELAY_MS,
    );
  }

  return undefined;
}

async function fetchXSearch(url: URL, bearerToken: string) {
  for (let attempt = 1; attempt <= X_API_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(url, {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
      });
    } catch (error) {
      if (attempt === X_API_MAX_ATTEMPTS) {
        throw new Error(
          `X API request failed after ${attempt} attempts: ${
            error instanceof Error ? error.message : "network request failed"
          }`,
        );
      }

      await sleep(X_API_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
      continue;
    }

    if (
      response.ok ||
      !X_API_RETRY_STATUS_CODES.has(response.status) ||
      attempt === X_API_MAX_ATTEMPTS
    ) {
      return { response, attempts: attempt };
    }

    const retryAfterDelayMs = getRetryAfterDelayMs(
      response.headers.get("retry-after"),
    );
    const fallbackDelayMs =
      X_API_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);

    await sleep(retryAfterDelayMs ?? fallbackDelayMs);
  }

  throw new Error("X API request did not return a response.");
}

function getPostUrl(postId: string, username?: string) {
  return username
    ? `https://x.com/${username}/status/${postId}`
    : `https://x.com/i/web/status/${postId}`;
}

function getImageUrl(media: TwitterMedia) {
  if (media.type === "photo" && media.url) {
    return media.url;
  }

  return media.preview_image_url;
}

async function getContentLength(url: string) {
  const response = await fetch(url, {
    method: "HEAD",
    cache: "no-store",
  });

  if (!response.ok) {
    return undefined;
  }

  const contentLength = Number(response.headers.get("content-length") || 0);

  return contentLength > 0 ? contentLength : undefined;
}

async function getPlayableMediaUrl(media: TwitterMedia) {
  if (media.type !== "video" && media.type !== "animated_gif") {
    return undefined;
  }

  if (
    typeof media.duration_ms !== "number" ||
    media.duration_ms > MAX_VIDEO_OR_GIF_DURATION_MS
  ) {
    return undefined;
  }

  const variants = (media.variants ?? [])
    .filter(
      (variant): variant is TwitterMediaVariant & { url: string } =>
        Boolean(variant.url) && variant.content_type === "video/mp4",
    )
    .sort((left, right) => (right.bit_rate ?? 0) - (left.bit_rate ?? 0));

  for (const variant of variants) {
    try {
      const contentLength = await getContentLength(variant.url);

      if (contentLength && contentLength <= MAX_VIDEO_OR_GIF_BYTES) {
        return variant.url;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

async function getAcceptedMedia(media: TwitterMedia) {
  const imageUrl = getImageUrl(media);

  if (!imageUrl) {
    return undefined;
  }

  if (media.type === "photo") {
    return {
      imageUrl,
      mediaType: "photo" as const,
    };
  }

  const mediaUrl = await getPlayableMediaUrl(media);

  if (!mediaUrl) {
    return undefined;
  }

  return {
    imageUrl,
    mediaUrl,
    mediaType:
      media.type === "animated_gif"
        ? ("animated_gif" as const)
        : ("video" as const),
  };
}

function getReadableTextCharacterCount(text: string) {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

async function fetchImageForOcr(imageUrl: string) {
  const response = await fetch(imageUrl, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Image download failed with ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);

  if (contentLength > OCR_MAX_IMAGE_BYTES) {
    throw new Error("Image is too large for OCR filtering.");
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());

  if (imageBuffer.byteLength > OCR_MAX_IMAGE_BYTES) {
    throw new Error("Image is too large for OCR filtering.");
  }

  return imageBuffer;
}

async function imageHasLittleOrNoText(
  worker: Awaited<ReturnType<typeof createWorker>>,
  imageUrl: string,
) {
  try {
    const imageBuffer = await fetchImageForOcr(imageUrl);
    const {
      data: { text },
    } = await worker.recognize(imageBuffer);

    return getReadableTextCharacterCount(text) <= OCR_TEXT_CHARACTER_LIMIT;
  } catch {
    return false;
  }
}

function isCachedTwitterImages(value: unknown): value is CachedTwitterImages {
  if (!value || typeof value !== "object") {
    return false;
  }

  const cache = value as Partial<CachedTwitterImages>;

  return (
    typeof cache.savedAt === "string" &&
    Array.isArray(cache.images) &&
    cache.images.every(
      (image) =>
        image &&
        typeof image.id === "string" &&
        typeof image.imageUrl === "string" &&
        typeof image.alt === "string" &&
        typeof image.sourceUrl === "string" &&
        typeof image.postText === "string" &&
        typeof image.authorName === "string" &&
        typeof image.width === "number" &&
        typeof image.height === "number" &&
        (typeof image.collectionName === "string" ||
          typeof image.trendName === "string"),
    )
  );
}

async function readImageCache() {
  try {
    const cacheText = await readFile(CACHE_FILE_PATH, "utf8");
    const cache = JSON.parse(cacheText) as unknown;

    if (!isCachedTwitterImages(cache)) {
      return undefined;
    }

    return cache;
  } catch {
    return undefined;
  }
}

async function readImageArchive() {
  try {
    const archiveText = await readFile(ARCHIVE_FILE_PATH, "utf8");
    const archive = JSON.parse(archiveText) as unknown;

    if (!isCachedTwitterImages(archive)) {
      return undefined;
    }

    return archive as SavedImageArchive;
  } catch {
    return undefined;
  }
}

function isGenerationJob(value: unknown): value is GenerationJob {
  if (!value || typeof value !== "object") {
    return false;
  }

  const job = value as Partial<GenerationJob>;

  return (
    (job.status === "idle" ||
      job.status === "running" ||
      job.status === "error") &&
    (job.readyCount === undefined || typeof job.readyCount === "number") &&
    (job.totalCount === undefined || typeof job.totalCount === "number") &&
    (job.startedAt === undefined || typeof job.startedAt === "string") &&
    (job.finishedAt === undefined || typeof job.finishedAt === "string") &&
    (job.message === undefined || typeof job.message === "string")
  );
}

function isSearchCursorCache(value: unknown): value is SearchCursorCache {
  if (!value || typeof value !== "object") {
    return false;
  }

  const cache = value as Partial<SearchCursorCache>;

  return (
    typeof cache.savedAt === "string" &&
    Boolean(cache.cursors) &&
    typeof cache.cursors === "object" &&
    Object.values(cache.cursors).every(
      (cursor) =>
        cursor &&
        typeof cursor === "object" &&
        typeof cursor.query === "string" &&
        typeof cursor.label === "string" &&
        typeof cursor.updatedAt === "string" &&
        (cursor.untilId === undefined || typeof cursor.untilId === "string"),
    )
  );
}

async function readSearchCursorCache(): Promise<SearchCursorCache> {
  try {
    const cacheText = await readFile(SEARCH_CURSOR_FILE_PATH, "utf8");
    const cache = JSON.parse(cacheText) as unknown;

    if (!isSearchCursorCache(cache)) {
      return { cursors: {}, savedAt: new Date().toISOString() };
    }

    return cache;
  } catch {
    return { cursors: {}, savedAt: new Date().toISOString() };
  }
}

async function writeSearchCursorCache(cache: SearchCursorCache) {
  await mkdir(path.dirname(SEARCH_CURSOR_FILE_PATH), { recursive: true });
  await writeFile(
    SEARCH_CURSOR_FILE_PATH,
    JSON.stringify({ ...cache, savedAt: new Date().toISOString() }, null, 2),
  );
}

async function readGenerationJob(): Promise<GenerationJob> {
  try {
    const jobText = await readFile(JOB_FILE_PATH, "utf8");
    const job = JSON.parse(jobText) as unknown;

    if (!isGenerationJob(job)) {
      return { status: "idle" };
    }

    return job;
  } catch {
    return { status: "idle" };
  }
}

async function writeGenerationJob(job: GenerationJob) {
  await mkdir(path.dirname(JOB_FILE_PATH), { recursive: true });
  await writeFile(JOB_FILE_PATH, JSON.stringify(job, null, 2));
}

function isActiveGenerationJob(job: GenerationJob) {
  if (job.status !== "running") {
    return false;
  }

  if (!job.startedAt) {
    return true;
  }

  const startedAt = Date.parse(job.startedAt);

  return Number.isNaN(startedAt)
    ? true
    : Date.now() - startedAt < JOB_STALE_AFTER_MS;
}

async function writeImageCache(images: GalleryImage[]) {
  if (images.length === 0) {
    return;
  }

  await mkdir(path.dirname(CACHE_FILE_PATH), { recursive: true });
  await writeFile(
    CACHE_FILE_PATH,
    JSON.stringify({ images, savedAt: new Date().toISOString() }, null, 2),
  );
}

async function appendImagesToArchive(images: GalleryImage[]) {
  if (images.length === 0) {
    return;
  }

  const archive = await readImageArchive();
  const archivedImages = archive?.images ?? [];
  const seen = new Set(
    archivedImages.map((image) => `${image.id}:${image.imageUrl}`),
  );
  const newImages = images.filter((image) => {
    const key = `${image.id}:${image.imageUrl}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  if (newImages.length === 0) {
    return;
  }

  await mkdir(path.dirname(ARCHIVE_FILE_PATH), { recursive: true });
  await writeFile(
    ARCHIVE_FILE_PATH,
    JSON.stringify(
      {
        images: [...newImages, ...archivedImages],
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function getImageUrlKey(imageUrl: string) {
  return imageUrl.toLowerCase();
}

function getSearchCursorKey(searchQuery: ImageSearchQuery) {
  return `${searchQuery.label}:${searchQuery.query}`;
}

function getOlderPostId(
  currentOldestPostId: string | undefined,
  candidatePostId: string,
) {
  if (!currentOldestPostId) {
    return candidatePostId;
  }

  try {
    return BigInt(candidatePostId) < BigInt(currentOldestPostId)
      ? candidatePostId
      : currentOldestPostId;
  } catch {
    return candidatePostId < currentOldestPostId
      ? candidatePostId
      : currentOldestPostId;
  }
}

function getIncompleteSearchMessage(
  imageCount: number,
  stats: ImageSearchStats,
) {
  const accountBreakdown = stats.accounts
    .map(
      (account) =>
        `${account.label}: ${account.postsScanned} posts, ${account.imageAttachmentsFound} images, ${account.duplicateImageUrls} duplicates, ${account.ocrRejectedImages} OCR rejects, ${account.acceptedImages} accepted, ${account.pagesScanned} pages${
          account.exhausted ? ", exhausted" : ""
        }`,
    )
    .join("; ");

  return `Loaded ${imageCount} configured account image attachment${
    imageCount === 1 ? "" : "s"
  }; configured accounts did not return ${IMAGE_LIMIT} new unique image URLs after saved-gallery and OCR filtering. Scanned ${
    stats.postsScanned
  } posts, found ${stats.imageAttachmentsFound} image attachment${
    stats.imageAttachmentsFound === 1 ? "" : "s"
  }, skipped ${stats.duplicateImageUrls} saved duplicate URL${
    stats.duplicateImageUrls === 1 ? "" : "s"
  }, and rejected ${stats.ocrRejectedImages} image${
    stats.ocrRejectedImages === 1 ? "" : "s"
  } with OCR-detected text or OCR/download failure. Per-account: ${accountBreakdown}.`;
}

async function fetchFreshTwitterImages(
  onProgress?: (progress: ImageSearchProgress) => Promise<void>,
): Promise<TwitterImageResult> {
  const bearerToken = getBearerToken();

  if (!bearerToken) {
    return {
      images: [],
      error:
        "Add TWITTER_BEARER_TOKEN or TWITTER_API_KEY to .env to load images from X.",
    };
  }

  const images: GalleryImage[] = [];
  const stats: ImageSearchStats = {
    postsScanned: 0,
    imageAttachmentsFound: 0,
    duplicateImageUrls: 0,
    ocrRejectedImages: 0,
    accounts: [],
  };
  const imageArchive = await readImageArchive();
  const searchCursorCache = await readSearchCursorCache();
  const seenImageUrls = new Set(
    imageArchive?.images.map((image) => getImageUrlKey(image.imageUrl)) ?? [],
  );
  const seenPostIds = new Set<string>();
  let searchQueries: Awaited<ReturnType<typeof getSearchQueries>>;
  const worker = await createWorker("eng", 1, {
    corePath: TESSERACT_CORE_PATH,
    langPath: TESSERACT_LANGUAGE_PATH,
    workerPath: TESSERACT_WORKER_PATH,
  });

  try {
    searchQueries = await getSearchQueries();
  } catch (error) {
    await worker.terminate();

    return {
      images: [],
      error:
        error instanceof Error
          ? error.message
          : "Unable to build X account search queries.",
    };
  }

  try {
    for (const searchQuery of searchQueries.queries) {
      if (images.length >= IMAGE_LIMIT) {
        break;
      }

      const accountStats: AccountSearchStats = {
        label: searchQuery.label,
        pagesScanned: 0,
        postsScanned: 0,
        imageAttachmentsFound: 0,
        duplicateImageUrls: 0,
        ocrRejectedImages: 0,
        acceptedImages: 0,
        exhausted: false,
      };
      let nextToken: string | undefined;
      let oldestScannedPostId: string | undefined;
      const cursorKey = getSearchCursorKey(searchQuery);
      const startingUntilId = searchCursorCache.cursors[cursorKey]?.untilId;

      stats.accounts.push(accountStats);

      for (
        let page = 0;
        page < MAX_SEARCH_PAGES_PER_QUERY && images.length < IMAGE_LIMIT;
        page += 1
      ) {
        accountStats.pagesScanned += 1;

        const url = new URL(SEARCH_ENDPOINT);
        url.searchParams.set("query", searchQuery.query);
        url.searchParams.set("max_results", "100");
        url.searchParams.set("sort_order", "recency");
        url.searchParams.set(
          "tweet.fields",
          "attachments,author_id,created_at,possibly_sensitive,public_metrics,text",
        );
        url.searchParams.set("expansions", "attachments.media_keys,author_id");
        url.searchParams.set(
          "media.fields",
          "alt_text,duration_ms,height,media_key,preview_image_url,type,url,variants,width",
        );
        url.searchParams.set("user.fields", "name,username");

        if (nextToken) {
          url.searchParams.set("next_token", nextToken);
        }

        if (startingUntilId) {
          url.searchParams.set("until_id", startingUntilId);
        }

        const { response, attempts } = await fetchXSearch(url, bearerToken);

        if (!response.ok) {
          const errorBody = await response.text();

          return {
            images,
            error: `X API request failed after ${attempts} attempt${
              attempts === 1 ? "" : "s"
            } with ${response.status}: ${truncateText(errorBody, 220)}`,
          };
        }

        const payload = (await response.json()) as TwitterSearchResponse;
        const mediaByKey = new Map(
          payload.includes?.media?.map((media) => [media.media_key, media]) ??
            [],
        );
        const usersById = new Map(
          payload.includes?.users?.map((user) => [user.id, user]) ?? [],
        );

        for (const post of payload.data ?? []) {
          stats.postsScanned += 1;
          accountStats.postsScanned += 1;
          oldestScannedPostId = getOlderPostId(oldestScannedPostId, post.id);

          if (post.possibly_sensitive || seenPostIds.has(post.id)) {
            continue;
          }

          const author = post.author_id
            ? usersById.get(post.author_id)
            : undefined;

          for (const mediaKey of post.attachments?.media_keys ?? []) {
            const media = mediaByKey.get(mediaKey);
            const acceptedMedia = media
              ? await getAcceptedMedia(media)
              : undefined;

            if (!media || !acceptedMedia) {
              continue;
            }

            stats.imageAttachmentsFound += 1;
            accountStats.imageAttachmentsFound += 1;

            if (seenImageUrls.has(getImageUrlKey(acceptedMedia.imageUrl))) {
              stats.duplicateImageUrls += 1;
              accountStats.duplicateImageUrls += 1;
              continue;
            }

            seenImageUrls.add(getImageUrlKey(acceptedMedia.imageUrl));

            if (!(await imageHasLittleOrNoText(worker, acceptedMedia.imageUrl))) {
              stats.ocrRejectedImages += 1;
              accountStats.ocrRejectedImages += 1;
              continue;
            }

            seenPostIds.add(post.id);
            accountStats.acceptedImages += 1;
            images.push({
              id: `${post.id}-${media.media_key}`,
              imageUrl: acceptedMedia.imageUrl,
              mediaUrl: acceptedMedia.mediaUrl,
              mediaType: acceptedMedia.mediaType,
              alt:
                media.alt_text ||
                post.text ||
                `Image attachment from post ${post.id}`,
              sourceUrl: getPostUrl(post.id, author?.username),
              postText: truncateText(post.text || "Image attachment"),
              authorName: author?.name || author?.username || "X user",
              username: author?.username,
              width: media.width || 1200,
              height: media.height || 900,
              collectionName: searchQuery.label,
            });

            await onProgress?.({
              readyCount: images.length,
              totalCount: IMAGE_LIMIT,
            });

            break;
          }

          if (images.length >= IMAGE_LIMIT) {
            break;
          }
        }

        nextToken = payload.meta?.next_token;

        if (!nextToken) {
          accountStats.exhausted = true;
          break;
        }
      }

      if (oldestScannedPostId) {
        searchCursorCache.cursors[cursorKey] = {
          query: searchQuery.query,
          label: searchQuery.label,
          untilId: oldestScannedPostId,
          updatedAt: new Date().toISOString(),
        };
        await writeSearchCursorCache(searchCursorCache);
      } else if (startingUntilId) {
        delete searchCursorCache.cursors[cursorKey];
        await writeSearchCursorCache(searchCursorCache);
      }
    }
  } finally {
    await worker.terminate();
  }

  return {
    images,
    error:
      images.length < IMAGE_LIMIT
        ? getIncompleteSearchMessage(images.length, stats)
        : undefined,
  };
}

async function getCachedTwitterImages(): Promise<TwitterImageResult> {
  const cachedImages = await readImageCache();

  if (cachedImages) {
    return {
      images: filterImagesToKnownAccounts(cachedImages.images),
    };
  }

  return {
    images: [],
    error: "No cached images yet. Press the button to generate the first set.",
  };
}

async function runImageGenerationJob() {
  const currentJob = await readGenerationJob();
  const startedAt = currentJob.startedAt || new Date().toISOString();

  try {
    const freshResult = await fetchFreshTwitterImages(async (progress) => {
      await writeGenerationJob({
        status: "running",
        readyCount: progress.readyCount,
        totalCount: progress.totalCount,
        startedAt,
        message: "Generating a new text-free image batch.",
      });
      revalidatePath("/");
    });

    if (freshResult.images.length === IMAGE_LIMIT) {
      await writeImageCache(freshResult.images);
      await appendImagesToArchive(freshResult.images);
      await writeGenerationJob({
        status: "idle",
        readyCount: IMAGE_LIMIT,
        totalCount: IMAGE_LIMIT,
        finishedAt: new Date().toISOString(),
        message: `Saved ${IMAGE_LIMIT} new text-free images.`,
      });
    } else {
      await writeGenerationJob({
        status: "error",
        readyCount: freshResult.images.length,
        totalCount: IMAGE_LIMIT,
        finishedAt: new Date().toISOString(),
        message:
          freshResult.error ||
          `Only found ${freshResult.images.length} usable image${
            freshResult.images.length === 1 ? "" : "s"
          }; kept the previous cached batch.`,
      });
    }
  } catch (error) {
    await writeGenerationJob({
      status: "error",
      readyCount: 0,
      totalCount: IMAGE_LIMIT,
      finishedAt: new Date().toISOString(),
      message:
        error instanceof Error
          ? error.message
          : "Image generation failed before a full batch was saved.",
    });
  }

  revalidatePath("/");
  revalidatePath("/gallery");
}

async function generateImages() {
  "use server";

  const currentJob = await readGenerationJob();

  if (!isActiveGenerationJob(currentJob)) {
    await writeGenerationJob({
      status: "running",
      readyCount: 0,
      totalCount: IMAGE_LIMIT,
      startedAt: new Date().toISOString(),
      message: "Generating a new text-free image batch.",
    });
    after(runImageGenerationJob);
  }

  revalidatePath("/");
  revalidatePath("/gallery");
  redirect("/");
}

function getProxiedVideoUrl(mediaUrl: string) {
  return `/api/x-video?url=${encodeURIComponent(mediaUrl)}`;
}

function GalleryMedia({ item }: { item: GalleryImage }) {
  if (
    item.mediaUrl &&
    (item.mediaType === "video" || item.mediaType === "animated_gif")
  ) {
    return (
      <a
        href={item.sourceUrl}
        target="_blank"
        rel="noreferrer"
        aria-label="Open source post"
      >
        <video
          src={getProxiedVideoUrl(item.mediaUrl)}
          poster={item.imageUrl}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          className="h-auto w-full"
        />
      </a>
    );
  }

  return (
    <a
      href={item.sourceUrl}
      target="_blank"
      rel="noreferrer"
      aria-label="Open source post"
    >
      <Image
        src={item.imageUrl}
        alt={item.alt}
        width={item.width}
        height={item.height}
        className="h-auto w-full transition duration-300 group-hover:scale-[1.02]"
        sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
      />
    </a>
  );
}

export default async function Home() {
  await connection();

  const { images, error } = await getCachedTwitterImages();
  const generationJob = await readGenerationJob();
  const isGenerating = isActiveGenerationJob(generationJob);
  const jobMessage =
    generationJob.status === "running" && !isGenerating
      ? "The last image generation timed out before a full batch was saved. Try again with the same button."
      : generationJob.message;

  return (
    <main className="min-h-screen bg-[#fbf8fb] text-[#211923]">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-6 border-b border-[#ead9e5] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="mb-3 text-sm font-semibold uppercase text-[#bc0082]">
              Image Pipeline Gallery
            </p>
            <h1 className="max-w-2xl text-4xl font-semibold leading-11 text-[#211923] sm:text-5xl sm:leading-14">
              Images pulled from configured X accounts.
            </h1>
            <form action={generateImages} className="mt-6">
              <button
                type="submit"
                disabled={isGenerating}
                className="rounded-lg bg-[#0fa958] px-8 py-4 text-lg font-bold uppercase tracking-normal text-white shadow-[0_14px_34px_rgba(15,169,88,0.28)] transition hover:bg-[#0b8e4a] focus:outline-none focus:ring-4 focus:ring-[#7ee2ad] disabled:cursor-wait disabled:bg-[#6fba8f]"
              >
                {isGenerating ? "generating" : "generate images!"}
              </button>
            </form>
            <GenerationRefresh active={isGenerating} />
            {isGenerating ? (
              <p className="mt-4 max-w-2xl text-sm font-medium leading-6 text-[#0b8e4a]">
                Generating a new batch. {generationJob.readyCount ?? 0} /{" "}
                {generationJob.totalCount ?? IMAGE_LIMIT} pictures ready.
              </p>
            ) : (generationJob.status === "error" ||
                generationJob.status === "running") &&
              jobMessage ? (
              <p className="mt-4 max-w-2xl text-sm font-medium leading-6 text-[#7a3149]">
                {jobMessage}
              </p>
            ) : error ? (
              <p className="mt-4 max-w-2xl text-sm font-medium leading-6 text-[#7a3149]">
                {error}
              </p>
            ) : null}
          </div>
        </header>

        <section
          aria-label="Configured account image gallery"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {images.map((item) => (
            <article
              key={item.id}
              className="group overflow-hidden rounded-lg border border-[#ead9e5] bg-white shadow-[0_18px_50px_rgba(35,18,31,0.08)]"
            >
              <GalleryMedia item={item} />
            </article>
          ))}
        </section>

        <Link
          href="/gallery"
          className="group flex items-center justify-between gap-4 rounded-lg border border-[#d6e6db] bg-[#f4fbf6] px-5 py-4 text-[#173522] transition hover:border-[#0fa958] hover:bg-[#eaf8ef]"
        >
          <div>
            <p className="text-sm font-semibold uppercase text-[#0b8e4a]">
              Saved gallery
            </p>
          </div>
          <span className="rounded-md bg-[#0fa958] px-4 py-2 text-sm font-bold uppercase text-white transition group-hover:bg-[#0b8e4a]">
            Open
          </span>
        </Link>
      </section>
    </main>
  );
}
