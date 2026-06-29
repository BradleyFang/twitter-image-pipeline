import type { GalleryImage } from "@/lib/twitter-images";

export const DEFAULT_NONCHALANT_API_URL = "http://localhost:3001";

export type NonchalantClientConfig = {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
};

export type NonchalantBatchImage = {
  imageUrl: string;
  sourceUrl: string;
  tweetId?: string;
  mediaKey?: string;
  alt?: string;
  postText?: string;
  authorName?: string;
  username?: string;
  collectionName?: string;
};

export type NonchalantTwitterCaptionBatchRequest = {
  images: NonchalantBatchImage[];
  imageSetSlug: string;
  studySlug: string;
  isCommonUse: false;
  topics: string[];
};

export type NonchalantMachineTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

export type NonchalantTwitterCaptionBatchResponse = {
  studyImageSetId: number;
  studyId: number;
  humorFlavorId: number;
  uploadedImages: Array<{
    sourceImageUrl: string;
    sourceUrl: string;
    imageId: string;
  }>;
  captionIds: string[];
  errors: unknown[];
};

type GalleryImageIdParts = {
  tweetId?: string;
  mediaKey?: string;
};

export function getNonchalantConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NonchalantClientConfig {
  const clientId = env.NONCHALANT_CLIENT_ID?.trim();
  const clientSecret = env.NONCHALANT_CLIENT_SECRET?.trim();

  if (!clientId) {
    throw new Error("Missing NONCHALANT_CLIENT_ID.");
  }

  if (!clientSecret) {
    throw new Error("Missing NONCHALANT_CLIENT_SECRET.");
  }

  return {
    apiUrl: (env.NONCHALANT_API_URL || DEFAULT_NONCHALANT_API_URL).replace(
      /\/+$/,
      "",
    ),
    clientId,
    clientSecret,
  };
}

export function createTwitterBatchSlug(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");

  return `twitter-${year}-${month}-${day}-${hour}${minute}`;
}

export function parseGalleryImageId(id: string): GalleryImageIdParts {
  const match = id.match(/^(\d+)-(.+)$/);

  if (!match) {
    return {};
  }

  return {
    tweetId: match[1],
    mediaKey: match[2],
  };
}

export function toNonchalantBatchImage(
  image: GalleryImage,
): NonchalantBatchImage {
  const idParts = parseGalleryImageId(image.id);

  return {
    imageUrl: image.imageUrl,
    sourceUrl: image.sourceUrl,
    ...idParts,
    alt: image.alt || undefined,
    postText: image.postText || undefined,
    authorName: image.authorName || undefined,
    username: image.username || undefined,
    collectionName: image.collectionName,
  };
}

export function buildTwitterCaptionBatchRequest(
  images: GalleryImage[],
  slug = createTwitterBatchSlug(),
): NonchalantTwitterCaptionBatchRequest {
  return {
    images: images.map(toNonchalantBatchImage),
    imageSetSlug: slug,
    studySlug: slug,
    isCommonUse: false,
    topics: [],
  };
}

async function readResponseBody(response: Response) {
  const text = await response.text();

  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatResponseBody(body: unknown) {
  if (typeof body === "string") {
    return body.slice(0, 500);
  }

  return JSON.stringify(body)?.slice(0, 500);
}

function getResponseContentType(response: Response) {
  return response.headers.get("content-type") || "";
}

function formatHttpError({
  action,
  response,
  url,
  body,
}: {
  action: string;
  response: Response;
  url: string;
  body: unknown;
}) {
  const htmlHint = getResponseContentType(response).includes("text/html")
    ? " The response was HTML, which usually means NONCHALANT_API_URL points at the web app or the wrong base path."
    : "";

  return `${action} failed with ${response.status} at ${url}: ${formatResponseBody(
    body,
  )}${htmlHint}`;
}

export async function requestNonchalantMachineToken(
  config: NonchalantClientConfig,
): Promise<NonchalantMachineTokenResponse> {
  const url = `${config.apiUrl}/auth/token`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(
      formatHttpError({
        action: "Nonchalant auth",
        response,
        url,
        body,
      }),
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Partial<NonchalantMachineTokenResponse>).access_token !==
      "string"
  ) {
    throw new Error("Nonchalant auth response did not include access_token.");
  }

  return body as NonchalantMachineTokenResponse;
}

export async function submitTwitterCaptionBatch(
  config: Pick<NonchalantClientConfig, "apiUrl">,
  accessToken: string,
  request: NonchalantTwitterCaptionBatchRequest,
): Promise<NonchalantTwitterCaptionBatchResponse> {
  const url = `${config.apiUrl}/pipeline/twitter-caption-batch`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(
      formatHttpError({
        action: "Nonchalant batch submit",
        response,
        url,
        body,
      }),
    );
  }

  return body as NonchalantTwitterCaptionBatchResponse;
}

export async function submitImagesToNonchalant(
  config: NonchalantClientConfig,
  images: GalleryImage[],
) {
  const token = await requestNonchalantMachineToken(config);
  const request = buildTwitterCaptionBatchRequest(images);
  const response = await submitTwitterCaptionBatch(
    config,
    token.access_token,
    request,
  );

  return {
    request,
    response,
  };
}
