import type { NextRequest } from "next/server";

const ALLOWED_VIDEO_HOSTNAME = "video.twimg.com";

function getRequestedVideoUrl(request: NextRequest) {
  const videoUrl = request.nextUrl.searchParams.get("url");

  if (!videoUrl) {
    return undefined;
  }

  try {
    const url = new URL(videoUrl);

    if (url.protocol !== "https:" || url.hostname !== ALLOWED_VIDEO_HOSTNAME) {
      return undefined;
    }

    return url;
  } catch {
    return undefined;
  }
}

export async function GET(request: NextRequest) {
  const videoUrl = getRequestedVideoUrl(request);

  if (!videoUrl) {
    return new Response("Invalid video URL", { status: 400 });
  }

  const range = request.headers.get("range");
  const upstreamHeaders = new Headers();

  if (range) {
    upstreamHeaders.set("range", range);
  }

  const upstreamResponse = await fetch(videoUrl, {
    cache: "no-store",
    headers: upstreamHeaders,
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return new Response("Video unavailable", {
      status: upstreamResponse.status || 502,
    });
  }

  const responseHeaders = new Headers();
  const passthroughHeaders = [
    "accept-ranges",
    "content-length",
    "content-range",
    "content-type",
  ];

  for (const headerName of passthroughHeaders) {
    const headerValue = upstreamResponse.headers.get(headerName);

    if (headerValue) {
      responseHeaders.set(headerName, headerValue);
    }
  }

  responseHeaders.set("cache-control", "private, max-age=3600");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
